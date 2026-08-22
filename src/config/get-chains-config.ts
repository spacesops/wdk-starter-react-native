const getChainsConfig = () => {
  const chainsConfig: Record<string, any> = {
    ethereum: {
      chainId: 1,
      blockchain: 'ethereum',
      provider: 'https://ethereum.publicnode.com',
      bundlerUrl: 'https://api.candide.dev/public/v3/ethereum',
      paymasterUrl: 'https://api.candide.dev/public/v3/ethereum',
      paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      safeModulesVersion: '0.3.0',
      transferMaxFee: 5000000,
      swapMaxFee: 5000000,
      bridgeMaxFee: 5000000,
      paymasterToken: {
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      },
    },
    // ethereum: {
    //   chainId: 1,
    //   blockchain: 'ethereum',
    //   provider: 'https://eth.merkle.io',
    //   bundlerUrl: 'https://api.candide.dev/public/v3/ethereum',
    //   paymasterUrl: 'https://api.candide.dev/public/v3/ethereum',
    //   paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
    //   entrypointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    //   transferMaxFee: 5000000,
    //   swapMaxFee: 5000000,
    //   bridgeMaxFee: 5000000,
    //   paymasterToken: {
    //     address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    //   }
    // },
    arbitrum: {
      chainId: 42161,
      blockchain: 'arbitrum',
      provider: 'https://arb1.arbitrum.io/rpc',
      bundlerUrl: 'https://api.candide.dev/public/v3/arbitrum',
      paymasterUrl: 'https://api.candide.dev/public/v3/arbitrum',
      paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      safeModulesVersion: '0.3.0',
      transferMaxFee: 5000000,
      swapMaxFee: 5000000,
      bridgeMaxFee: 5000000,
      paymasterToken: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      },
    },
    polygon: {
      chainId: 137,
      blockchain: 'polygon',
      provider: 'https://polygon-bor.publicnode.com',
      bundlerUrl: 'https://api.candide.dev/public/v3/polygon',
      paymasterUrl: 'https://api.candide.dev/public/v3/polygon',
      paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      safeModulesVersion: '0.3.0',
      transferMaxFee: 5000000,
      swapMaxFee: 5000000,
      bridgeMaxFee: 5000000,
      paymasterToken: {
        address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      },
    },
    ton: {
      chainId: 607,
      blockchain: 'ton',
      // wdk-wallet-ton reads only tonClient (TON Center) for balances/transfers.
      // tonApiClient is not wired upstream; getFeeRates() calls tonapi.io/v2 without auth.
      tonClient: {
        url: 'https://toncenter.com/api/v2/jsonRPC',
        ...(process.env.EXPO_PUBLIC_TON_CENTER_API_KEY
          ? { secretKey: process.env.EXPO_PUBLIC_TON_CENTER_API_KEY }
          : {}),
      },
      paymasterToken: {
        address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
      },
      transferMaxFee: 1000000000,
    },
    tron: {
      chainId: 728126428,
      blockchain: 'tron',
      provider: 'https://api.trongrid.io',
      gasFreeProvider: 'https://gasfree.io',
      apiKey: process.env.EXPO_PUBLIC_TRON_API_KEY,
      apiSecret: process.env.EXPO_PUBLIC_TRON_API_SECRET,
      serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E',
      verifyingContract: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc',
      transferMaxFee: 10000000,
      swapMaxFee: 1000000,
      bridgeMaxFee: 1000000,
      paymasterToken: {
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      },
    },
    solana: {
      chainId: 101,
      blockchain: 'solana',
      provider: 'https://api.mainnet-beta.solana.com',
      commitment: 'confirmed',
    },
    bitcoin: {
      chainId: 8332,
      blockchain: 'bitcoin',
      // Delete the wallet when switching to testnet or back to mainnet.
      network: process.env.EXPO_PUBLIC_BITCOIN_NETWORK, // BITCOIN_NETWORK
      host: process.env.EXPO_PUBLIC_ELECTRS_HOST, // ELECTRS_HOST
      port: process.env.EXPO_PUBLIC_ELECTRS_PORT
        ? Number(process.env.EXPO_PUBLIC_ELECTRS_PORT)
        : undefined, // ELECTRS_PORT (converted to number)
      protocol: process.env.EXPO_PUBLIC_ELECTRS_PROTOCOL as 'tcp' | 'tls' | 'ssl' | undefined, // ELECTRS_PROTOCOL (defaults to 'tcp' in wallet-btc)

      // For P2TR (Taproot) addresses (bc1p...), use BIP-86
      // For P2WPKH (Native SegWit) addresses (bc1q...), use BIP-84
      // Currently configured for P2TR wallet: bc1pcp2p7nzg8kknr42w6yel8k7hpy5tedjpacnwlvtfhzgmaq6u4qnq06nhac
      // Derivation path format: m/{bip}'/{network}'/{account}'/{change}/{index}
      // - For testnet (network='testnet'): m/86'/1'/0'/0/0 (first address)
      // - For mainnet (network='bitcoin'): m/86'/0'/0'/0/0 (first address)
      bip: 86, // Use BIP86 for Taproot (m/86') addresses
      script_type: 'P2TR', // Use P2TR for Taproot addresses
      // bip: 84, // Use BIP84 for native SegWit (m/84') addresses
      // script_type: 'P2WPKH', // Use P2WPKH for native SegWit addresses
    },
    // pear-wrk-wdk requiredNetworks — worklet init fails without these keys even if the UI omits them.
    sepolia: {
      chainId: 11155111,
      blockchain: 'sepolia',
      provider: 'https://ethereum-sepolia-rpc.publicnode.com',
      bundlerUrl: 'https://api.candide.dev/public/v3/sepolia',
      paymasterUrl: 'https://api.candide.dev/public/v3/sepolia',
      paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      safeModulesVersion: '0.3.0',
      paymasterToken: {
        address: '0xd077A400968890Eacc75cdc901F0356c943e4fDb',
      },
      transferMaxFee: 100000,
    },
    plasma: {
      chainId: 9745,
      blockchain: 'plasma',
      provider: 'https://rpc.plasma.to',
      bundlerUrl: 'https://api.candide.dev/public/v3/9745',
      paymasterUrl: 'https://api.candide.dev/public/v3/9745',
      paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      safeModulesVersion: '0.3.0',
      paymasterToken: {
        address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
      },
      transferMaxFee: 100000,
    },
    spark: {
      // chainId must be positive for core's NetworkConfig schema; spark wallets read `network`.
      chainId: 99999,
      blockchain: 'spark',
      network: 'MAINNET',
    },
  };
  return chainsConfig;
};

export default getChainsConfig;
