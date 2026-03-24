// @ts-nocheck
import 'dotenv/config'

import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createMintToInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'

import { useWeb3Js } from './lib/solanaRuntime'
import { parseDecimalToUnits } from './lib/solanaUtils'
import { DEFAULTS, getEnv, readSolanaDeployment } from './utils'

async function main() {
    const deployment = readSolanaDeployment(DEFAULTS.localEid) || {}
    const rpcUrl = getEnv('SOLANA_RPC_URL', DEFAULTS.solanaRpcUrl)
    const mintAddress = getEnv('SOLANA_MINT', deployment.mint)
    const mintAuthority = getEnv('SOLANA_MINT_AUTHORITY', deployment.mintAuthority)
    const tokenProgramId = new PublicKey(getEnv('SOLANA_TOKEN_PROGRAM', deployment.tokenProgram || DEFAULTS.tokenProgram))
    const recipient = new PublicKey(getEnv('RECIPIENT'))
    const amountInput = getEnv('AMOUNT')

    const connection = new Connection(rpcUrl, 'confirmed')
    const { web3JsKeypair } = await useWeb3Js()
    const mint = new PublicKey(mintAddress)
    const authority = new PublicKey(mintAuthority)

    const decimals = (await connection.getTokenSupply(mint, 'confirmed')).value.decimals
    const amount = parseDecimalToUnits(amountInput, decimals)
    const ata = getAssociatedTokenAddressSync(
        mint,
        recipient,
        false,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
    )

    const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
            web3JsKeypair.publicKey,
            ata,
            recipient,
            mint,
            tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createMintToInstruction(
            mint,
            ata,
            authority,
            amount,
            [web3JsKeypair.publicKey],
            tokenProgramId
        )
    )

    const signature = await sendAndConfirmTransaction(connection, tx, [web3JsKeypair], {
        commitment: 'confirmed',
    })
    const balance = await connection.getTokenAccountBalance(ata, 'confirmed')

    console.log(`refundTx=${signature}`)
    console.log(`recipientAta=${ata.toBase58()}`)
    console.log(`balance=${balance.value.amount}`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
