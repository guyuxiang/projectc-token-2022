import * as anchor from '@coral-xyz/anchor'

async function main() {
    const url =
        process.env.SOLANA_RPC_URL || 'https://devnet.helius-rpc.com/?api-key=7c8a6828-2b0b-456b-a1fc-f08073e8304a'
    const commitment: anchor.web3.Commitment = 'confirmed'
    const connection = new anchor.web3.Connection(url, commitment)
    const wallet = anchor.Wallet.local()
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment,
        preflightCommitment: commitment,
    })

    anchor.setProvider(provider)

    const deployScript = require('../migrations/deploy.ts')
    await deployScript(provider)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
