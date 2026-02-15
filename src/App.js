import React, { FC, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import '@solana/wallet-adapter-react-ui/styles.css';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const BRAINS_MINT = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
const RPC_ENDPOINT = 'https://rpc.mainnet.x1.xyz';
const BRAINS_LOGO = 'https://mint.xdex.xyz/ipfs/QmWVZ29dfptaWTcJRT6ePsCJS5juoV36afrWL8WqTKGo75?pinataGatewayToken=yMPvcPv-nyFCJ0GGUmoHxYkuVS6bZxS_ucWqpMpVMedA3_nOdJO5uUqA8dibii5a';

// Metaplex Token Metadata Program ID (X1 is SVM-compatible, same program)
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Token-2022 extension type discriminant for metadata
const TOKEN_2022_METADATA_EXTENSION_TYPE = 19; // Type 19 = TokenMetadata in Token-2022

// IPFS gateway fallback chain — ordered by reliability
// Private Pinata URLs (peach-obvious-jaguar-174.mypinata.cloud) will have
// their CID extracted and re-fetched through these public gateways
const IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://dweb.link/ipfs/',
  'https://nftstorage.link/ipfs/',
];

// xdex API — confirmed endpoints from official documentation
const XDEX_API = 'https://api.xdex.xyz';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
interface TokenData {
  mint: string;
  name: string;
  symbol: string;
  balance: number;
  decimals: number;
  logoUri?: string;
  isToken2022: boolean;
  metaSource?: 'token2022ext' | 'metaplex' | 'xdex' | 'fallback';
}

interface XDexMintInfo {
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  logo?: string;
}

interface ResolvedMeta {
  name: string;
  symbol: string;
  logoUri?: string;
  metaSource: TokenData['metaSource'];
}

// ─────────────────────────────────────────────
// UTILITY: Fetch with timeout + abort
// ─────────────────────────────────────────────
async function fetchWithTimeout(url: string, ms = 5000): Promise<any> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

// ─────────────────────────────────────────────
// UTILITY: Extract IPFS CID from any gateway URL or ipfs:// URI
// Handles: ipfs://CID, https://*/ipfs/CID, https://CID.ipfs.*.link
// ─────────────────────────────────────────────
function extractIpfsCid(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.slice(7).split('?')[0].split('/')[0];
  const ipfsPath = uri.match(/\/ipfs\/([a-zA-Z0-9]{46,})/);
  if (ipfsPath) return ipfsPath[1].split('?')[0];
  const subdomain = uri.match(/^https?:\/\/([a-zA-Z0-9]{46,})\.ipfs\./);
  if (subdomain) return subdomain[1];
  return null;
}

// ─────────────────────────────────────────────
// UTILITY: Resolve any URI format to a fetchable HTTPS URL
// Handles ipfs://, private Pinata gateways, ar://, relative /paths, plain https
// ─────────────────────────────────────────────
function resolveUri(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const cid = extractIpfsCid(s);
  if (cid) return `${IPFS_GATEWAYS[0]}${cid}`;
  if (s.startsWith('ar://'))  return `https://arweave.net/${s.slice(5)}`;
  if (s.startsWith('/'))      return `https://api.xdex.xyz${s}`;
  return s;
}

// ─────────────────────────────────────────────
// UTILITY: Fetch off-chain JSON metadata URI and extract logo
// Handles private Pinata gateways, ipfs://, arweave, https
// Extracts CID and retries all public gateways on any 403/failure
// ─────────────────────────────────────────────
async function fetchOffChainLogo(uri: string): Promise<string | undefined> {
  const urls: string[] = [];
  const cid = extractIpfsCid(uri);

  if (cid) {
    IPFS_GATEWAYS.forEach(gw => urls.push(`${gw}${cid}`));
  } else if (uri.startsWith('ar://')) {
    urls.push(`https://arweave.net/${uri.slice(5)}`);
  } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
    urls.push(uri);
  } else if (uri.startsWith('/')) {
    urls.push(`https://api.xdex.xyz${uri}`);
  }

  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const json = await r.json();
      const raw: string = json?.image || json?.logoURI || json?.logo || json?.icon || '';
      if (!raw) continue;
      const logoCid = extractIpfsCid(raw);
      if (logoCid) return `${IPFS_GATEWAYS[0]}${logoCid}`;
      if (raw.startsWith('ar://')) return `https://arweave.net/${raw.slice(5)}`;
      if (raw.startsWith('http')) return raw;
      return raw;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────
// STRATEGY 1a: Token-2022 Metadata Extension
//
// X1 tokens minted via xdex/mint.xdex.xyz use Token-2022 with the
// metadata extension baked directly into the mint account.
// getParsedAccountInfo returns it in the extensions[] array.
// ─────────────────────────────────────────────
// STRATEGY 1: Token-2022 Metadata Extension
// Works perfectly — do not touch
// ─────────────────────────────────────────────
async function tryToken2022Extension(
  connection: any,
  mintAddress: string
): Promise<ResolvedMeta | null> {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(mintPubkey);
    const parsed = info?.value?.data?.parsed;
    if (!parsed) return null;
    const mintInfo = parsed?.info;
    if (!mintInfo) return null;
    const extensions: any[] = mintInfo?.extensions ?? [];
    const metaExt = extensions.find((e: any) => e?.extension === 'tokenMetadata');
    if (!metaExt?.state) return null;
    const state = metaExt.state;
    const name: string = (state.name ?? '').replace(/\0/g, '').trim();
    const symbol: string = (state.symbol ?? '').replace(/\0/g, '').trim();
    const uri: string = (state.uri ?? '').replace(/\0/g, '').trim();
    if (!name && !symbol) return null;
    let logoUri: string | undefined;
    if (uri) logoUri = await fetchOffChainLogo(uri);
    return {
      name: name || symbol || 'Unknown',
      symbol: symbol || name.slice(0, 6).toUpperCase() || '???',
      logoUri,
      metaSource: 'token2022ext',
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// STRATEGY 2: Metaplex PDA (classic SPL)
// Uses connection.getParsedAccountInfo on the PDA
// which returns structured data without manual byte decoding
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SINGLE METAPLEX PDA — X1 RPC
// Individual fallback for tokens not in the batch.
// Same logic as batch decoder, direct getAccountInfo call.
// ─────────────────────────────────────────────
async function tryMetaplexPDA(
  connection: any,
  mintAddress: string
): Promise<ResolvedMeta | null> {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mintAddress).toBuffer()],
      METADATA_PROGRAM_ID
    );

    const acct = await connection.getAccountInfo(pda);
    if (!acct?.data) return null;

    const raw: Uint8Array = acct.data instanceof Uint8Array
      ? acct.data
      : typeof acct.data === 'string'
        ? Uint8Array.from(atob(acct.data), (c: string) => c.charCodeAt(0))
        : new Uint8Array(acct.data);

    if (raw.length < 65 + 4) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 65;

    const nameLen = view.getUint32(o, true); o += 4;
    if (!nameLen || nameLen > 200 || o + nameLen > raw.length) return null;
    const name = new TextDecoder().decode(raw.slice(o, o + nameLen)).replace(/\0/g, '').trim();
    o += nameLen;

    const symLen = view.getUint32(o, true); o += 4;
    if (symLen > 50 || o + symLen > raw.length) return null;
    const symbol = new TextDecoder().decode(raw.slice(o, o + symLen)).replace(/\0/g, '').trim();
    o += symLen;

    const uriLen = view.getUint32(o, true); o += 4;
    if (uriLen > 500 || o + uriLen > raw.length) return null;
    const uri = new TextDecoder().decode(raw.slice(o, o + uriLen)).replace(/\0/g, '').trim();

    if (!name && !symbol) return null;
    if (name && !/^[\x20-\x7E\u00A0-\uFFFF]{1,60}$/.test(name)) return null;

    const logoUri = uri ? await fetchOffChainLogo(uri) : undefined;
    console.log(`[Metaplex single] ✓ ${mintAddress.slice(0,8)} → "${name}" (${symbol})`);
    return { name: name||'Unknown', symbol: symbol||'???', logoUri, metaSource: 'metaplex' };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// XDEX REGISTRY — for xdex-minted Token-2022 tokens
// that use the xdex registry logo format
// ─────────────────────────────────────────────
function tryXdexRegistry(
  registry: Map<string, XDexMintInfo>,
  mintAddress: string
): ResolvedMeta | null {
  const entry = registry.get(mintAddress);
  if (!entry) return null;
  const logoUri = resolveUri(entry.logo ?? '') ?? undefined;
  return { name: entry.name||'Unknown', symbol: entry.symbol||'???', logoUri, metaSource: 'xdex' };
}

// ─────────────────────────────────────────────
// BATCH METAPLEX PDA — X1 RPC PRIMARY
//
// Derives all Metaplex PDAs, fetches in one getMultipleAccountsInfo
// call on rpc.mainnet.x1.xyz — same connection as Token-2022.
// This is the correct source for ALL X1 SPL token metadata.
// ─────────────────────────────────────────────
async function batchFetchMetaplexPDAs(
  connection: any,
  mintAddresses: string[]
): Promise<Map<string, { name: string; symbol: string; uri: string }>> {
  const result = new Map<string, { name: string; symbol: string; uri: string }>();
  if (mintAddresses.length === 0) return result;

  console.log(`[Metaplex batch] Starting — ${mintAddresses.length} SPL mints to look up on X1 RPC`);
  mintAddresses.forEach((m, i) => console.log(`  [${i}] ${m}`));

  try {
    const pdaMap = mintAddresses.map(mint => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
        METADATA_PROGRAM_ID
      );
      console.log(`[Metaplex batch] ${mint.slice(0,8)} → PDA ${pda.toBase58().slice(0,8)}...`);
      return { mint, pda };
    });

    const BATCH = 100;
    for (let i = 0; i < pdaMap.length; i += BATCH) {
      const chunk = pdaMap.slice(i, i + BATCH);
      let accounts: any[] = [];
      try {
        // Pass encoding explicitly — X1 RPC returns raw account data as base64
        accounts = await connection.getMultipleAccountsInfo(
          chunk.map((x: any) => x.pda),
          { encoding: 'base64' }
        );
      } catch (e: any) {
        console.warn(`[Metaplex batch] RPC getMultipleAccountsInfo failed: ${e.message}`);
        continue;
      }

      const found = accounts.filter(Boolean).length;
      console.log(`[Metaplex batch] RPC returned ${found}/${chunk.length} non-null accounts`);

      // Log first account's raw shape so we can debug encoding issues
      if (accounts[0]) {
        const a0 = accounts[0];
        console.log(`[Metaplex batch] first acct keys: ${Object.keys(a0).join(', ')}`);
        console.log(`[Metaplex batch] first acct owner: ${a0.owner?.toBase58?.() ?? a0.owner}`);
        console.log(`[Metaplex batch] first acct data type: ${typeof a0.data}, isArray: ${Array.isArray(a0.data)}, isBuffer: ${a0.data instanceof Uint8Array}`);
        if (Array.isArray(a0.data)) {
          console.log(`[Metaplex batch] first acct data[0] (b64 snippet): ${String(a0.data[0]).slice(0, 80)}`);
          console.log(`[Metaplex batch] first acct data[1] (encoding): ${a0.data[1]}`);
        } else if (a0.data instanceof Uint8Array || Buffer.isBuffer(a0.data)) {
          console.log(`[Metaplex batch] first acct data length: ${a0.data.length}`);
          console.log(`[Metaplex batch] first 10 bytes: [${Array.from(a0.data.slice(0,10)).join(',')}]`);
        }
      } else {
        console.warn(`[Metaplex batch] first account is NULL — PDAs don't exist on X1 for these mints`);
      }

      accounts.forEach((acct: any, idx: number) => {
        if (!acct?.data) return;
        const { mint } = chunk[idx];
        try {
          // Handle all data formats the X1 RPC may return:
          // 1. Buffer / Uint8Array (default @solana/web3.js format)
          // 2. [base64string, "base64"] array (some RPC nodes)
          // 3. Plain base64 string
          let raw: Uint8Array;
          const d = acct.data;
          if (d instanceof Uint8Array || Buffer.isBuffer(d)) {
            raw = d instanceof Uint8Array ? d : new Uint8Array(d);
          } else if (Array.isArray(d) && typeof d[0] === 'string') {
            // [base64data, "base64"] array format
            raw = Uint8Array.from(atob(d[0]), (c: string) => c.charCodeAt(0));
            console.log(`[Metaplex batch] ${mint.slice(0,8)} decoded from [b64, "base64"] array, len=${raw.length}`);
          } else if (typeof d === 'string') {
            raw = Uint8Array.from(atob(d), (c: string) => c.charCodeAt(0));
          } else {
            console.warn(`[Metaplex batch] ${mint.slice(0,8)} unknown data format: ${typeof d}`);
            return;
          }

          // Metaplex v1 binary layout:
          // 1 byte key + 32 bytes update_authority + 32 bytes mint = offset 65
          // then: u32 nameLen + name bytes (null padded)
          //       u32 symLen  + symbol bytes
          //       u32 uriLen  + uri bytes
          if (raw.length < 65 + 4) {
            console.warn(`[Metaplex batch] ${mint.slice(0,8)} data too short: ${raw.length} bytes`);
            return;
          }
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          let o = 65;

          const nameLen = view.getUint32(o, true); o += 4;
          console.log(`[Metaplex batch] ${mint.slice(0,8)} raw=${raw.length}b offset65 nameLen=${nameLen}`);
          if (!nameLen || nameLen > 200 || o + nameLen > raw.length) {
            console.warn(`[Metaplex batch] ${mint.slice(0,8)} invalid nameLen=${nameLen} — bad PDA data or wrong offset`);
            return;
          }
          const name = new TextDecoder().decode(raw.slice(o, o + nameLen)).replace(/\0/g, '').trim();
          o += nameLen;

          const symLen = view.getUint32(o, true); o += 4;
          if (symLen > 50 || o + symLen > raw.length) return;
          const symbol = new TextDecoder().decode(raw.slice(o, o + symLen)).replace(/\0/g, '').trim();
          o += symLen;

          const uriLen = view.getUint32(o, true); o += 4;
          if (uriLen > 500 || o + uriLen > raw.length) return;
          const uri = new TextDecoder().decode(raw.slice(o, o + uriLen)).replace(/\0/g, '').trim();

          if (!name && !symbol) return;
          if (name && !/^[\x20-\x7E\u00A0-\uFFFF]{1,60}$/.test(name)) {
            console.warn(`[Metaplex batch] ${mint.slice(0,8)} garbage name, skipping`);
            return;
          }

          console.log(`[Metaplex batch] ✓ ${mint.slice(0,8)} → "${name}" (${symbol}) uri="${uri.slice(0,50)}"`);
          result.set(mint, { name, symbol, uri });
        } catch (e: any) {
          console.warn(`[Metaplex batch] decode ${mint.slice(0,8)}: ${e.message}`);
        }
      });
    }
  } catch (e: any) {
    console.warn(`[Metaplex batch] outer error: ${e.message}`);
  }

  console.log(`[Metaplex batch] Resolved ${result.size}/${mintAddresses.length} SPL tokens from X1 RPC`);
  return result;
}

// ─────────────────────────────────────────────
// MASTER RESOLVER
//  ① Token-2022 extension  — inline metadata from X1 RPC (works)
//  ② Metaplex PDA cache    — X1 RPC batch (primary for SPL)
//  ③ xdex registry         — xdex-minted Token-2022 tokens
//  ④ BRAINS hardcoded      — known BRAINS token
//  ⑤ Single Metaplex PDA  — individual X1 RPC fallback
//  ⑥ Fallback              — truncated mint address
// ─────────────────────────────────────────────
async function resolveTokenMeta(
  connection: any,
  mintAddress: string,
  xdexRegistry: Map<string, XDexMintInfo>,
  metaplexCache?: Map<string, { name: string; symbol: string; uri: string }>,
  logoCache?: Map<string, string | undefined>
): Promise<ResolvedMeta> {

  // ① Token-2022 extension — inline metadata via X1 RPC getParsedAccountInfo
  const t2022 = await tryToken2022Extension(connection, mintAddress);
  if (t2022) return t2022;

  // ② Metaplex PDA batch cache — X1 RPC, same connection
  if (metaplexCache?.has(mintAddress)) {
    const m = metaplexCache.get(mintAddress)!;
    let logoUri = logoCache?.get(mintAddress);
    if (logoUri === undefined && m.uri) {
      logoUri = await fetchOffChainLogo(m.uri);
      logoCache?.set(mintAddress, logoUri);
    }
    return { name: m.name||'Unknown', symbol: m.symbol||'???', logoUri, metaSource: 'metaplex' };
  }

  // ③ xdex mint/list registry (Token-2022 minted on xdex with logo data)
  const xdexCached = tryXdexRegistry(xdexRegistry, mintAddress);
  if (xdexCached) return xdexCached;

  // ④ BRAINS hardcoded
  if (mintAddress === BRAINS_MINT) {
    return { name: 'Brains', symbol: 'BRAINS', logoUri: BRAINS_LOGO, metaSource: 'xdex' };
  }

  // ⑤ Single Metaplex PDA — direct X1 RPC call for any token not in batch
  const metaplex = await tryMetaplexPDA(connection, mintAddress);
  if (metaplex) return metaplex;

  // ⑥ Absolute fallback — show truncated mint address
  console.warn(`[resolver] FALLBACK for ${mintAddress.slice(0,8)} — no metadata on X1 RPC`);
  return {
    name: `${mintAddress.slice(0, 6)}…${mintAddress.slice(-4)}`,
    symbol: mintAddress.slice(0, 5).toUpperCase(),
    logoUri: undefined,
    metaSource: 'fallback',
  };
}

// ─────────────────────────────────────────────
// GLOBAL CSS injected once
// ─────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Sora:wght@300;400;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #080c0f;
    font-family: 'Sora', sans-serif;
    color: #d4e0ec;
    min-height: 100vh;
  }

  /* Custom scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #111820; }
  ::-webkit-scrollbar-thumb { background: #ff8c00; border-radius: 3px; }

  /* Wallet adapter button override */
  .wallet-adapter-button {
    background: linear-gradient(135deg, #ff8c00, #ffb700) !important;
    color: #0a0e14 !important;
    font-family: 'Orbitron', monospace !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    letter-spacing: 1px !important;
    border-radius: 8px !important;
    border: none !important;
    padding: 12px 24px !important;
    transition: all 0.2s !important;
    text-transform: uppercase !important;
  }
  .wallet-adapter-button:hover {
    background: linear-gradient(135deg, #ffb700, #ff8c00) !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 20px rgba(255, 140, 0, 0.5) !important;
  }
  .wallet-adapter-modal-wrapper {
    background: #111820 !important;
    border: 1px solid #1e3050 !important;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse-orange {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,140,0,0.4); }
    50%       { box-shadow: 0 0 0 10px rgba(255,140,0,0); }
  }
  @keyframes scanline {
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(100vh); }
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
`;

function injectGlobalCSS() {
  if (document.getElementById('x1brains-css')) return;
  const style = document.createElement('style');
  style.id = 'x1brains-css';
  style.textContent = GLOBAL_CSS;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────
// TOKEN LOGO COMPONENT
// ─────────────────────────────────────────────
const TokenLogo: FC<{ token: TokenData; size?: number }> = ({ token, size = 44 }) => {
  const [failed, setFailed] = useState(false);

  if (token.logoUri && !failed) {
    return (
      <img
        src={token.logoUri}
        alt={token.symbol}
        onError={() => setFailed(true)}
        style={{
          width: size, height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '2px solid rgba(255,140,0,0.3)',
          flexShrink: 0,
          background: '#111820',
        }}
      />
    );
  }

  // Fallback: colored initial
  const colors = ['#ff8c00', '#ffb700', '#00d4ff', '#00c98d', '#bf5af2'];
  const colorIdx = token.symbol.charCodeAt(0) % colors.length;
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      background: `linear-gradient(135deg, ${colors[colorIdx]}, ${colors[(colorIdx + 2) % colors.length]})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#0a0e14', fontWeight: 800, fontSize: size * 0.38,
      fontFamily: 'Orbitron, monospace',
      flexShrink: 0,
      border: '2px solid rgba(255,140,0,0.2)',
    }}>
      {token.symbol.charAt(0).toUpperCase()}
    </div>
  );
};

// ─────────────────────────────────────────────
// META SOURCE BADGE
// ─────────────────────────────────────────────
const MetaBadge: FC<{ source?: string }> = ({ source }) => {
  if (!source) return null;
  const cfg: Record<string, { label: string; color: string; bg: string }> = {
    token2022ext: { label: 'T-2022 EXT', color: '#ffb700', bg: 'rgba(255,183,0,0.1)' },
    metaplex:     { label: 'METAPLEX',   color: '#00d4ff', bg: 'rgba(0,212,255,0.1)' },
    xdex:         { label: 'XDEX',       color: '#ff8c00', bg: 'rgba(255,140,0,0.1)' },
    fallback:     { label: 'UNKNOWN',    color: '#6b7f90', bg: 'rgba(107,127,144,0.1)' },
  };
  const c = cfg[source] ?? cfg.fallback;
  return (
    <span style={{
      fontSize: 9, fontFamily: 'Orbitron, monospace', fontWeight: 700,
      color: c.color, background: c.bg,
      border: `1px solid ${c.color}40`,
      padding: '2px 6px', borderRadius: 4,
      letterSpacing: 1,
    }}>
      {c.label}
    </span>
  );
};

// ─────────────────────────────────────────────
// MAIN TOKEN CARD
// ─────────────────────────────────────────────
const TokenCard: FC<{
  token: TokenData;
  highlight?: 'native' | 'brains';
  copiedAddress: string | null;
  onCopy: (addr: string) => void;
  animDelay?: number;
}> = ({ token, highlight, copiedAddress, onCopy, animDelay = 0 }) => {

  const borderColor =
    highlight === 'native' ? '#00d4ff' :
    highlight === 'brains' ? '#ff8c00' :
    token.isToken2022      ? '#ffb700' :
    '#1e3050';

  const bgGradient =
    highlight === 'native' ? 'linear-gradient(135deg, rgba(0,212,255,0.06), rgba(0,212,255,0.02))' :
    highlight === 'brains' ? 'linear-gradient(135deg, rgba(255,140,0,0.08), rgba(255,183,0,0.04))' :
    token.isToken2022      ? 'linear-gradient(135deg, rgba(255,183,0,0.06), rgba(255,140,0,0.02))' :
    'linear-gradient(135deg, #111820, #0d1520)';

  return (
    <div style={{
      background: bgGradient,
      border: `1px solid ${borderColor}`,
      borderRadius: 12,
      padding: '18px 20px',
      marginBottom: 12,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      animation: `fadeUp 0.4s ease ${animDelay}s both`,
      transition: 'border-color 0.2s, transform 0.2s, box-shadow 0.2s',
      cursor: 'default',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLDivElement).style.borderColor = highlight === 'brains' ? '#ffb700' : highlight === 'native' ? '#00d4ff' : '#ff8c00';
      (e.currentTarget as HTMLDivElement).style.transform = 'translateX(3px)';
      (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 20px ${borderColor}30`;
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLDivElement).style.borderColor = borderColor;
      (e.currentTarget as HTMLDivElement).style.transform = 'translateX(0)';
      (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
    }}
    >
      {/* Corner accent */}
      <div style={{
        position: 'absolute', top: 0, left: 0,
        width: 3, height: '100%',
        background: borderColor,
        opacity: highlight ? 1 : 0.4,
      }} />

      {/* Left: logo + info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, paddingLeft: 10 }}>
        {highlight === 'native' ? (
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(0,212,255,0.05))',
            border: '2px solid rgba(0,212,255,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, flexShrink: 0,
          }}>⚡</div>
        ) : (
          <TokenLogo token={token} />
        )}

        <div style={{ minWidth: 0, flex: 1 }}>
          {/* Symbol row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'Orbitron, monospace',
              fontSize: 16, fontWeight: 700,
              color: highlight === 'native' ? '#00d4ff' : highlight === 'brains' ? '#ff8c00' : '#e8f0f8',
            }}>{token.symbol}</span>
            {token.isToken2022 && (
              <span style={{
                fontSize: 8, fontWeight: 700, fontFamily: 'Orbitron, monospace',
                color: '#ffb700', background: 'rgba(255,183,0,0.1)',
                border: '1px solid rgba(255,183,0,0.3)',
                padding: '1px 5px', borderRadius: 3, letterSpacing: 1,
              }}>T-2022</span>
            )}
            <MetaBadge source={token.metaSource} />
          </div>
          {/* Name */}
          <div style={{ fontSize: 12, color: '#5c7a90', marginBottom: 5 }}>{token.name}</div>
          {/* Address */}
          {token.mint && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                fontFamily: 'Sora, monospace', fontSize: 10, color: '#3a5570',
              }}>
                {token.mint.slice(0, 10)}…{token.mint.slice(-4)}
              </span>
              <button
                onClick={() => onCopy(token.mint)}
                style={{
                  background: copiedAddress === token.mint ? 'rgba(0,201,141,0.2)' : 'rgba(255,140,0,0.15)',
                  border: `1px solid ${copiedAddress === token.mint ? 'rgba(0,201,141,0.4)' : 'rgba(255,140,0,0.3)'}`,
                  color: copiedAddress === token.mint ? '#00c98d' : '#ff8c00',
                  padding: '2px 7px', borderRadius: 4,
                  cursor: 'pointer', fontSize: 10,
                  fontFamily: 'Orbitron, monospace',
                  transition: 'all 0.2s',
                }}
              >
                {copiedAddress === token.mint ? '✓' : 'COPY'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: balance */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{
          fontFamily: 'Orbitron, monospace',
          fontSize: token.balance > 999999 ? 16 : 22,
          fontWeight: 700,
          color: highlight === 'native' ? '#00d4ff' : highlight === 'brains' ? '#ffb700' : '#c8d8e8',
          lineHeight: 1.2,
          marginBottom: 3,
        }}>
          {token.balance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: token.decimals > 4 ? 4 : token.decimals,
          })}
        </div>
        {token.decimals !== undefined && highlight !== 'native' && (
          <div style={{ fontSize: 9, color: '#3a5570', fontFamily: 'Orbitron, monospace', letterSpacing: 1 }}>
            {token.decimals} DEC
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// SECTION HEADER
// ─────────────────────────────────────────────
const SectionHeader: FC<{ label: string; count?: number; color?: string }> = ({
  label, count, color = '#ff8c00'
}) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 12,
    marginBottom: 16, marginTop: 28,
  }}>
    <span style={{
      fontFamily: 'Orbitron, monospace', fontSize: 10,
      fontWeight: 700, letterSpacing: 3,
      color, textTransform: 'uppercase',
    }}>
      {label}
    </span>
    {count !== undefined && (
      <span style={{
        background: `${color}20`,
        border: `1px solid ${color}40`,
        color,
        fontFamily: 'Orbitron, monospace',
        fontSize: 9, fontWeight: 700,
        padding: '2px 8px', borderRadius: 10,
      }}>{count}</span>
    )}
    <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${color}40, transparent)` }} />
  </div>
);

// ─────────────────────────────────────────────
// LOADING SPINNER
// ─────────────────────────────────────────────
const Spinner: FC<{ label?: string }> = ({ label = 'Loading...' }) => (
  <div style={{ textAlign: 'center', padding: '50px 20px' }}>
    <div style={{
      width: 48, height: 48,
      border: '3px solid rgba(255,140,0,0.15)',
      borderTop: '3px solid #ff8c00',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      margin: '0 auto 16px',
    }} />
    <div style={{
      fontFamily: 'Orbitron, monospace', fontSize: 10,
      color: '#5c7a90', letterSpacing: 2, textTransform: 'uppercase',
    }}>{label}</div>
  </div>
);

// ─────────────────────────────────────────────
// STATS BAR
// ─────────────────────────────────────────────
const StatsBar: FC<{ items: { label: string; value: string | number; color?: string }[] }> = ({ items }) => (
  <div style={{
    display: 'flex', gap: 1, marginBottom: 24,
    background: '#0d1520', borderRadius: 10,
    border: '1px solid #1e3050',
    overflow: 'hidden',
  }}>
    {items.map((item, i) => (
      <div key={i} style={{
        flex: 1, padding: '12px 16px', textAlign: 'center',
        borderRight: i < items.length - 1 ? '1px solid #1e3050' : 'none',
      }}>
        <div style={{
          fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 700,
          color: item.color || '#ff8c00', marginBottom: 3,
        }}>{item.value}</div>
        <div style={{ fontSize: 9, color: '#3a5570', letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'Orbitron, monospace' }}>
          {item.label}
        </div>
      </div>
    ))}
  </div>
);

// ─────────────────────────────────────────────
// MAIN CONTENT
// ─────────────────────────────────────────────
const MainContent: FC = () => {
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  const [xntBalance, setXntBalance] = useState<number | null>(null);
  const [brainsToken, setBrainsToken] = useState<TokenData | null>(null);
  const [splTokens, setSplTokens] = useState<TokenData[]>([]);
  const [token2022s, setToken2022s] = useState<TokenData[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Scanning X1 chain...');
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [xdexRegistry, setXdexRegistry] = useState<Map<string, XDexMintInfo>>(new Map());
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [registrySize, setRegistrySize] = useState(0);

  // ── Load xdex registry on mount (Strategy 3 fallback)
  useEffect(() => {
    loadXdexRegistry();
  }, []);

  useEffect(() => {
    if (publicKey && registryLoaded) {
      loadTokens();
    } else if (!publicKey) {
      reset();
    }
  }, [publicKey?.toBase58(), registryLoaded]);

  const reset = () => {
    setXntBalance(null);
    setBrainsToken(null);
    setSplTokens([]);
    setToken2022s([]);
  };

  // ── Load xdex registry
  // Confirmed working endpoint: api.xdex.xyz/api/xendex/mint/list?network=mainnet
  // Returns: [{ token_address, name, symbol, decimals, logo }]
  const loadXdexRegistry = async () => {
    try {
      const response = await fetch(`${XDEX_API}/api/xendex/mint/list?network=mainnet`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) throw new Error(`xdex registry HTTP ${response.status}`);
      const data = await response.json();

      // ── LOG: show exact response shape so we can debug field names
      console.log('[xdex mint/list] raw response type:', typeof data, Array.isArray(data) ? `array[${data.length}]` : 'object');
      if (Array.isArray(data) && data.length > 0) {
        console.log('[xdex mint/list] first entry:', JSON.stringify(data[0]));
        console.log('[xdex mint/list] keys:', Object.keys(data[0]).join(', '));
      } else if (data && typeof data === 'object') {
        console.log('[xdex mint/list] top-level keys:', Object.keys(data).join(', '));
        const arr = data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? [];
        if (arr.length > 0) console.log('[xdex mint/list] nested first entry:', JSON.stringify(arr[0]));
      }

      const registry = new Map<string, XDexMintInfo>();
      // Handle both array response and { data: [...] } wrapper
      const tokens: any[] = Array.isArray(data) ? data : (data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? []);

      tokens.forEach((token: any) => {
        // Try every likely address field name
        const address = token.token_address ?? token.address ?? token.mint ?? token.mintAddress ?? token.tokenAddress;
        if (address) {
          registry.set(address, {
            token_address: address,
            name: (token.name ?? token.tokenName ?? 'Unknown').toString().replace(/\0/g, '').trim(),
            symbol: (token.symbol ?? token.tokenSymbol ?? address.slice(0, 4).toUpperCase()).toString().replace(/\0/g, '').trim(),
            decimals: token.decimals ?? 9,
            logo: token.logo ?? token.logoURI ?? token.logoUrl ?? token.image ?? token.icon,
          });
        }
      });

      console.log(`[xdex mint/list] Registry built: ${registry.size} tokens`);
      if (registry.size > 0) {
        const sample = [...registry.values()][0];
        console.log('[xdex mint/list] sample entry:', JSON.stringify(sample));
      }
      setXdexRegistry(registry);
      setRegistrySize(registry.size);
    } catch (err) {
      console.warn('[xdex mint/list] Failed:', err);
    } finally {
      setRegistryLoaded(true);
    }
  };

  // ── Main token load — uses the resolver chain for metadata
  const loadTokens = async () => {
    if (!publicKey) return;
    setLoading(true);

    try {
      setLoadingLabel('Fetching XNT balance...');
      const lamports = await connection.getBalance(publicKey);
      setXntBalance(lamports / 1e9);

      // SPL token metadata fetched below via X1 RPC Metaplex batch

      setLoadingLabel('Loading SPL token accounts...');
      const splAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      // Log raw SPL account data so we can see what the RPC returns
      if (splAccounts.value.length > 0) {
        console.log('[SPL accounts] count:', splAccounts.value.length);
        console.log('[SPL accounts] first account parsed.info:', JSON.stringify(splAccounts.value[0].account.data.parsed.info));
      }

      let token2022Accounts = { value: [] as any[] };
      try {
        setLoadingLabel('Loading Token-2022 accounts...');
        token2022Accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
      } catch {
        // Token-2022 query not available — degrade gracefully
      }

      const allAccounts = [
        ...splAccounts.value.map((a: any) => ({ ...a, is2022: false })),
        ...token2022Accounts.value.map((a: any) => ({ ...a, is2022: true })),
      ];

      setLoadingLabel(`Resolving metadata for ${allAccounts.length} tokens...`);

      // Collect all non-zero SPL mint addresses (deduped)
      const nonZeroAccounts = allAccounts.filter(acc =>
        (acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0) > 0
      );
      const splMints = [...new Set(
        nonZeroAccounts
          .filter((a: any) => !a.is2022)
          .map((a: any) => a.account.data.parsed.info.mint as string)
      )];

      // ── BATCH METAPLEX PDA FETCH via X1 RPC ──────────────────────
      // Same connection as Token-2022 (rpc.mainnet.x1.xyz)
      // One getMultipleAccountsInfo call for all SPL token PDAs
      setLoadingLabel(`Fetching SPL token metadata from X1 RPC (${splMints.length} tokens)...`);
      const metaplexCache = await batchFetchMetaplexPDAs(connection, splMints);
      const logoCache = new Map<string, string | undefined>();

      const spl: TokenData[] = [];
      const t2022: TokenData[] = [];
      let brains: TokenData | null = null;

      const results = await Promise.allSettled(
        allAccounts.map(async (acc) => {
          const info = acc.account.data.parsed.info;
          const balance: number = info.tokenAmount.uiAmount ?? 0;
          if (balance <= 0) return null;
          const mint: string = info.mint;

          const meta = await resolveTokenMeta(connection, mint, xdexRegistry, metaplexCache, logoCache);
          return {
            mint,
            balance,
            decimals: info.tokenAmount.decimals,
            isToken2022: acc.is2022,
            name: meta.name,
            symbol: meta.symbol,
            logoUri: meta.logoUri,
            metaSource: meta.metaSource,
          } as TokenData;
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const token = result.value;
        if (token.mint === BRAINS_MINT) {
          brains = token;
        } else if (token.isToken2022) {
          t2022.push(token);
        } else {
          spl.push(token);
        }
      }

      spl.sort((a, b) => b.balance - a.balance);
      t2022.sort((a, b) => b.balance - a.balance);

      setBrainsToken(brains);
      setSplTokens(spl);
      setToken2022s(t2022);

      console.log(`[X1 Brains] Loaded: ${spl.length} SPL, ${t2022.length} T-2022, BRAINS: ${brains ? 'YES' : 'NO'}`);
    } catch (err) {
      console.error('[X1 Brains] Load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const totalTokens = 1 + (brainsToken ? 1 : 0) + splTokens.length + token2022s.length;
  const metaplexCount = [...(brainsToken ? [brainsToken] : []), ...splTokens, ...token2022s]
    .filter(t => t.metaSource === 'token2022ext' || t.metaSource === 'metaplex').length;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#080c0f',
      padding: '24px 16px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        backgroundImage: `
          linear-gradient(rgba(255,140,0,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,140,0,0.025) 1px, transparent 1px)
        `,
        backgroundSize: '48px 48px',
        pointerEvents: 'none',
      }} />

      {/* Ambient glow blobs */}
      <div style={{
        position: 'fixed', top: -200, right: -200,
        width: 600, height: 600, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,140,0,0.06) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0,
      }} />
      <div style={{
        position: 'fixed', bottom: -300, left: -200,
        width: 700, height: 700, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,212,255,0.04) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0,
      }} />

      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: 680, margin: '0 auto',
      }}>

        {/* ── HEADER ── */}
        <div style={{ textAlign: 'center', marginBottom: 36, animation: 'fadeUp 0.5s ease both' }}>
          {/* Logo */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <div style={{
              position: 'relative',
              width: 80, height: 80,
            }}>
              <div style={{
                position: 'absolute', inset: -4,
                borderRadius: '50%',
                background: 'conic-gradient(from 0deg, #ff8c00, #ffb700, #00d4ff, #ff8c00)',
                animation: 'spin 4s linear infinite',
                opacity: 0.6,
              }} />
              <img
                src={BRAINS_LOGO}
                alt="BRAINS"
                style={{
                  position: 'relative', zIndex: 1,
                  width: 80, height: 80,
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: '3px solid #0a0e14',
                }}
                onError={e => {
                  const el = e.currentTarget as HTMLImageElement;
                  el.style.display = 'none';
                }}
              />
            </div>
          </div>

          <h1 style={{
            fontFamily: 'Orbitron, monospace',
            fontSize: 32, fontWeight: 900,
            letterSpacing: 4,
            background: 'linear-gradient(135deg, #ff8c00 0%, #ffb700 40%, #00d4ff 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            margin: '0 0 8px 0',
            textTransform: 'uppercase',
          }}>
            X1 BRAINS
          </h1>
          <p style={{
            fontFamily: 'Orbitron, monospace',
            fontSize: 9, letterSpacing: 4,
            color: '#3a5570', textTransform: 'uppercase',
          }}>
            X1 Blockchain · Portfolio Tracker
          </p>
        </div>

        {/* ── WALLET CONNECT ── */}
        <div style={{
          display: 'flex', justifyContent: 'center',
          marginBottom: 28,
          animation: 'fadeUp 0.5s ease 0.1s both',
        }}>
          <WalletMultiButton />
        </div>

        {/* ── CONNECTED ADDRESS ── */}
        {publicKey && (
          <div style={{
            background: 'linear-gradient(135deg, #0d1520, #111820)',
            border: '1px solid #1e3050',
            borderRadius: 10,
            padding: '12px 18px',
            marginBottom: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12,
            animation: 'fadeUp 0.4s ease 0.15s both',
          }}>
            <div>
              <div style={{
                fontFamily: 'Orbitron, monospace', fontSize: 8,
                color: '#3a5570', letterSpacing: 3, marginBottom: 5,
                textTransform: 'uppercase',
              }}>Connected Operator</div>
              <div style={{
                fontFamily: 'Sora, monospace', fontSize: 11,
                color: '#00d4ff',
                wordBreak: 'break-all',
              }}>{publicKey.toBase58()}</div>
            </div>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#00c98d',
              flexShrink: 0,
              animation: 'pulse-orange 2s ease infinite',
              boxShadow: '0 0 0 0 rgba(0,201,141,0.4)',
            }} />
          </div>
        )}

        {/* ── CONTENT ── */}
        {publicKey && (
          <>
            {loading ? (
              <div style={{ animation: 'fadeUp 0.4s ease both' }}>
                <Spinner label={loadingLabel} />
              </div>
            ) : (
              <div style={{ animation: 'fadeUp 0.4s ease both' }}>

                {/* Stats bar */}
                <StatsBar items={[
                  { label: 'Total Tokens', value: totalTokens, color: '#ff8c00' },
                  { label: 'On-chain Meta', value: metaplexCount, color: '#00d4ff' },
                  { label: 'xDex Listed', value: registrySize, color: '#ffb700' },
                  {
                    label: 'XNT Balance',
                    value: xntBalance !== null
                      ? xntBalance.toLocaleString(undefined, { maximumFractionDigits: 3 })
                      : '—',
                    color: '#00d4ff'
                  },
                ]} />

                {/* XNT native */}
                <SectionHeader label="Native Token" color="#00d4ff" />
                <TokenCard
                  token={{
                    mint: '', name: 'X1 Native Token', symbol: 'XNT',
                    balance: xntBalance ?? 0, decimals: 9,
                    isToken2022: false, metaSource: undefined,
                  }}
                  highlight="native"
                  copiedAddress={copiedAddress}
                  onCopy={copyAddress}
                  animDelay={0.05}
                />

                {/* BRAINS token */}
                {brainsToken && (
                  <>
                    <SectionHeader label="BRAINS Token" color="#ff8c00" />
                    <TokenCard
                      token={brainsToken}
                      highlight="brains"
                      copiedAddress={copiedAddress}
                      onCopy={copyAddress}
                      animDelay={0.1}
                    />
                  </>
                )}

                {/* SPL tokens */}
                {splTokens.length > 0 && (
                  <>
                    <SectionHeader label="SPL Tokens" count={splTokens.length} color="#ffb700" />
                    {splTokens.map((t, i) => (
                      <TokenCard
                        key={t.mint}
                        token={t}
                        copiedAddress={copiedAddress}
                        onCopy={copyAddress}
                        animDelay={0.05 * i}
                      />
                    ))}
                  </>
                )}

                {/* Token-2022 */}
                {token2022s.length > 0 && (
                  <>
                    <SectionHeader label="Token-2022" count={token2022s.length} color="#ffb700" />
                    {token2022s.map((t, i) => (
                      <TokenCard
                        key={t.mint}
                        token={t}
                        copiedAddress={copiedAddress}
                        onCopy={copyAddress}
                        animDelay={0.05 * i}
                      />
                    ))}
                  </>
                )}

                {/* Refresh button */}
                <button
                  onClick={loadTokens}
                  style={{
                    width: '100%',
                    marginTop: 28,
                    padding: '14px 0',
                    background: 'linear-gradient(135deg, #ff8c00, #ffb700)',
                    border: 'none', borderRadius: 10,
                    fontFamily: 'Orbitron, monospace',
                    fontSize: 11, fontWeight: 700,
                    letterSpacing: 2, color: '#0a0e14',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 24px rgba(255,140,0,0.4)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
                  }}
                >
                  ⟳ &nbsp;Refresh Balances
                </button>

                {/* Pipeline credit */}
                <div style={{
                  marginTop: 16,
                  padding: '10px 14px',
                  background: 'rgba(0,212,255,0.04)',
                  border: '1px solid rgba(0,212,255,0.1)',
                  borderRadius: 8,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: '#00d4ff', flexShrink: 0,
                  }} />
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 8,
                    color: '#3a5570', letterSpacing: 1.5,
                  }}>
                    METADATA: T-2022 EXT → METAPLEX PDA (X1 RPC) → XDEX REGISTRY
                  </span>
                </div>

              </div>
            )}
          </>
        )}

        {/* ── EMPTY STATE ── */}
        {!publicKey && (
          <div style={{
            textAlign: 'center', padding: '60px 20px',
            animation: 'fadeUp 0.5s ease 0.2s both',
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
            <div style={{
              fontFamily: 'Orbitron, monospace',
              fontSize: 11, color: '#3a5570',
              letterSpacing: 3, textTransform: 'uppercase',
            }}>
              Connect wallet to scan X1 portfolio
            </div>
          </div>
        )}

        {/* ── FOOTER ── */}
        <footer style={{
          marginTop: 48,
          paddingTop: 20,
          borderTop: '1px solid #1e3050',
          display: 'flex', justifyContent: 'center',
          gap: 24, flexWrap: 'wrap',
        }}>
          {[
            { label: 'X1.Ninja', href: 'https://x1.ninja' },
            { label: 'X1 Brains', href: 'https://x1brains.xyz' },
            { label: 'XDex', href: 'https://app.xdex.xyz' },
            { label: 'Explorer', href: 'https://explorer.mainnet.x1.xyz' },
          ].map(link => (
            <a key={link.href}
              href={link.href}
              target="_blank" rel="noopener noreferrer"
              style={{
                fontFamily: 'Orbitron, monospace',
                fontSize: 9, letterSpacing: 2,
                color: '#3a5570',
                textDecoration: 'none',
                textTransform: 'uppercase',
                transition: 'color 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.color = '#ff8c00'}
              onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.color = '#3a5570'}
            >
              {link.label}
            </a>
          ))}
        </footer>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────
const App: FC = () => {
  useEffect(() => { injectGlobalCSS(); }, []);

  const wallets = [
    new PhantomWalletAdapter(),
    new BackpackWalletAdapter(),
  ];

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <MainContent />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

export default App;
