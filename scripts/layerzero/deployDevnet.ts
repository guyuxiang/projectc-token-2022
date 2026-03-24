// @ts-nocheck
import 'dotenv/config'

import { fetchMint } from '@metaplex-foundation/mpl-toolbox'
import { transactionBuilder } from '@metaplex-foundation/umi'
import {
    fromWeb3JsInstruction,
    fromWeb3JsPublicKey,
    toWeb3JsPublicKey,
} from '@metaplex-foundation/umi-web3js-adapters'
import { AuthorityType, TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

import { deriveConnection } from './lib/solanaRuntime'
import { checkMultisigSigners, createMintAuthorityMultisig } from './lib/multisig'
import { deriveNativeOftStore, initNativeOft } from './lib/nativeOft'
import { DEFAULTS, getEnv, writeSolanaDeployment } from './utils'

async function main() {
    const mint = new PublicKey(getEnv('SOLANA_MINT'))
    const programId = fromWeb3JsPublicKey(new PublicKey(getEnv('SOLANA_OFT_PROGRAM_ID', DEFAULTS.oftProgramId)))
    const tokenProgram = fromWeb3JsPublicKey(
        new PublicKey(getEnv('SOLANA_TOKEN_PROGRAM', TOKEN_2022_PROGRAM_ID.toBase58()))
    )
    const sharedDecimals = Number(process.env.SHARED_DECIMALS || 6)
    const additionalMinter = process.env.ADDITIONAL_MINTER
    const computeUnitPriceScaleFactor = Number(process.env.COMPUTE_UNIT_PRICE_SCALE_FACTOR || 4)

    const { connection, umi, umiWalletSigner } = await deriveConnection(DEFAULTS.localEid)
    const [oftStore] = deriveNativeOftStore(programId, fromWeb3JsPublicKey(mint))
    const oftStoreAccount = await umi.rpc.getAccount(oftStore)

    let initTxHash: string | null = null
    if (!oftStoreAccount.exists) {
        const initIx = initNativeOft(
            {
                payer: umiWalletSigner,
                admin: umiWalletSigner.publicKey,
                mint: fromWeb3JsPublicKey(mint),
            },
            {
                sharedDecimals,
                tokenProgram,
            },
            {
                oft: programId,
            }
        )
        const receipt = await transactionBuilder().add(initIx).sendAndConfirm(umi)
        initTxHash = receipt.signature
        console.log(`initNativeOftTx=${receipt.signature}`)
    } else {
        console.log(`oftStore already exists: ${oftStore}`)
    }

    const mintInfo = await fetchMint(umi, fromWeb3JsPublicKey(mint))
    const currentMintAuthority =
        mintInfo.mintAuthority && mintInfo.mintAuthority.__option === 'Some'
            ? mintInfo.mintAuthority.value
            : null
    const currentFreezeAuthority =
        mintInfo.freezeAuthority && mintInfo.freezeAuthority.__option === 'Some'
            ? mintInfo.freezeAuthority.value
            : null

    const extraMinters = additionalMinter
        ? [new PublicKey(additionalMinter)]
        : [toWeb3JsPublicKey(umiWalletSigner.publicKey)]
    const expectedSigners = [toWeb3JsPublicKey(oftStore), ...extraMinters]

    let mintAuthority: PublicKey
    if (currentMintAuthority) {
        mintAuthority = new PublicKey(currentMintAuthority)
        await checkMultisigSigners(connection, mintAuthority, expectedSigners)
        console.log(`reusing mint authority: ${mintAuthority.toBase58()}`)
    } else {
        mintAuthority = await createMintAuthorityMultisig(
            connection,
            umi,
            DEFAULTS.localEid,
            umiWalletSigner,
            toWeb3JsPublicKey(oftStore),
            toWeb3JsPublicKey(tokenProgram),
            extraMinters,
            computeUnitPriceScaleFactor
        )
    }

    let authorityTxHash: string | null = null
    const signerAddress = toWeb3JsPublicKey(umiWalletSigner.publicKey).toBase58()
    const signerControlsMint =
        currentMintAuthority === signerAddress || currentFreezeAuthority === signerAddress
    if (
        signerControlsMint &&
        (currentMintAuthority !== mintAuthority.toBase58() ||
            (currentFreezeAuthority !== null && currentFreezeAuthority !== mintAuthority.toBase58()))
    ) {
        const tokenProgramPk = toWeb3JsPublicKey(tokenProgram)
        const authorityTx = transactionBuilder().add({
            instruction: fromWeb3JsInstruction(
                createSetAuthorityInstruction(
                    mint,
                    toWeb3JsPublicKey(umiWalletSigner.publicKey),
                    AuthorityType.MintTokens,
                    mintAuthority,
                    [toWeb3JsPublicKey(umiWalletSigner.publicKey)],
                    tokenProgramPk
                )
            ),
            signers: [umiWalletSigner],
            bytesCreatedOnChain: 0,
        })
        if (currentFreezeAuthority) {
            authorityTx.add({
                instruction: fromWeb3JsInstruction(
                    createSetAuthorityInstruction(
                        mint,
                        toWeb3JsPublicKey(umiWalletSigner.publicKey),
                        AuthorityType.FreezeAccount,
                        mintAuthority,
                        [toWeb3JsPublicKey(umiWalletSigner.publicKey)],
                        tokenProgramPk
                    )
                ),
                signers: [umiWalletSigner],
                bytesCreatedOnChain: 0,
            })
        }
        const receipt = await authorityTx.sendAndConfirm(umi)
        authorityTxHash = receipt.signature
        console.log(`setAuthorityTx=${receipt.signature}`)
    } else if (!signerControlsMint) {
        console.log(
            `mint authority is already external to deployer (${currentMintAuthority ?? 'none'}); skipping authority update`
        )
    } else {
        console.log(`mint/freeze authority already set to ${mintAuthority.toBase58()}`)
    }

    writeSolanaDeployment(DEFAULTS.localEid, {
        network: 'solana-testnet',
        eid: DEFAULTS.localEid,
        programId: programId.toString(),
        mint: mint.toBase58(),
        mintAuthority: mintAuthority.toBase58(),
        oftStore: oftStore.toString(),
        deployer: toWeb3JsPublicKey(umiWalletSigner.publicKey).toBase58(),
        tokenProgram: toWeb3JsPublicKey(tokenProgram).toBase58(),
        initTxHash,
        authorityTxHash,
    })

    console.log(`programId=${programId}`)
    console.log(`mint=${mint.toBase58()}`)
    console.log(`oftStore=${oftStore}`)
    console.log(`mintAuthority=${mintAuthority.toBase58()}`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
