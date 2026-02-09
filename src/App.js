import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider, useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import '@solana/wallet-adapter-react-ui/styles.css';

function App() {
  // Custom RPC for X1 Mainnet (Solana-compatible)
  const endpoint = 'https://rpc.mainnet.x1.xyz';
  const network = WalletAdapterNetwork.Custom; // Use custom since X1 isn't built-in

  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BalanceChecker />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function BalanceChecker() {
  const { publicKey, connect } = useWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = React.useState(null);

  // $BRAINS token mint address on X1
  const tokenMint = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');

  React.useEffect(() => {
    const fetchBalance = async () => {
      if (publicKey) {
        try {
          // Get the user's associated token account for $BRAINS
          const ata = await getAssociatedTokenAddress(tokenMint, publicKey);
          const account = await getAccount(connection, ata);
          setBalance(account.amount / 1e9); // Assuming 9 decimals, adjust if needed
        } catch (error) {
          console.error('Error fetching balance:', error);
          setBalance('Account not found or error');
        }
      }
    };
    fetchBalance();
  }, [publicKey, connection]);

  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h1>X1Brains Balance Checker DApp</h1>
      <WalletMultiButton />
      {publicKey ? (
        <p>Wallet: {publicKey.toBase58()}</p>
      ) : (
        <p>Connect your wallet to check balance.</p>
      )}
      {balance !== null && <p>Your $BRAINS Balance: {balance}</p>}
    </div>
  );
}

export default App;