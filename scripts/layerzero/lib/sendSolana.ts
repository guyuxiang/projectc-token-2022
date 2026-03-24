import { findAssociatedTokenPda } from '@metaplex-foundation/mpl-toolbox'
import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

import { createLogger, promptToContinue } from '@layerzerolabs/io-devtools'
import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { addressToBytes32 } from '@layerzerolabs/lz-v2-utilities'
import { oft } from '@layerzerolabs/oft-v2-solana-sdk'

import { SendResult } from './commonTypes'
import { DebugLogger, KnownErrors, isEmptyOptionsSolana } from './wireSupport'
import { parseDecimalToUnits, silenceSolana429 } from './solanaUtils'
import { deriveNativeOftStore, quoteNative, sendNative } from './nativeOft'
import {
    TransactionType,
    addComputeUnitInstructions,
    deriveConnection,
    getDefaultAddressLookupTable,
    getLayerZeroScanLink,
    getSolanaDeployment,
} from './solanaRuntime'

const logger = createLogger()

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5, delayMs = 1500): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error
            if (attempt === attempts) break
            logger.warn(`${label} failed on attempt ${attempt}/${attempts}, retrying: ${error}`)
            await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
    }
    throw lastError
}

export interface SolanaArgs {
    amount: string
    to: string
    srcEid: EndpointId
    dstEid: EndpointId
    minAmount?: string
    extraOptions?: string
    composeMsg?: string
    oftAddress?: string
    oftProgramId?: string
    tokenProgram?: string
    computeUnitPriceScaleFactor?: number
    addressLookupTables?: string[]
}

export async function sendSolana({
    amount,
    to,
    srcEid,
    dstEid,
    oftAddress,
    oftProgramId,
    tokenProgram: tokenProgramStr,
    computeUnitPriceScaleFactor = 4,
    minAmount,
    extraOptions,
    composeMsg,
    addressLookupTables,
}: SolanaArgs): Promise<SendResult> {
    const { connection, umi, umiWalletSigner } = await deriveConnection(srcEid)
    silenceSolana429(connection)
    const programId = oftProgramId
        ? publicKey(oftProgramId)
        : publicKey(
              (() => {
                  try {
                      return getSolanaDeployment(srcEid).programId
                  } catch (error) {
                      logger.error(`No Program ID found for ${srcEid}: ${error}`)
                      throw error
                  }
              })()
          )

    const localDeployment = getSolanaDeployment(srcEid)
    const storePda = oftAddress ? publicKey(oftAddress) : publicKey(localDeployment.oftStore)
    const mintPk = new PublicKey(localDeployment.mint)
    const derivedStorePda = deriveNativeOftStore(programId, fromWeb3JsPublicKey(mintPk))[0]
    const effectiveStorePda = storePda ?? derivedStorePda

    const tokenProgramId = tokenProgramStr ? publicKey(tokenProgramStr) : fromWeb3JsPublicKey(TOKEN_PROGRAM_ID)
    const tokenAccount = findAssociatedTokenPda(umi, {
        mint: fromWeb3JsPublicKey(mintPk),
        owner: umiWalletSigner.publicKey,
        tokenProgramId,
    })
    if (!tokenAccount) throw new Error(`No token account for mint ${mintPk}`)
    const tokenAccountPk = toWeb3JsPublicKey(tokenAccount[0])
    const tokenBalance = await withRetry('getTokenAccountBalance', () =>
        connection.getTokenAccountBalance(tokenAccountPk, 'confirmed')
    )
    const balance = BigInt(tokenBalance.value.amount)

    const mintSupply = await withRetry('getTokenSupply', () => connection.getTokenSupply(mintPk, 'confirmed'))
    const decimals = mintSupply.value.decimals
    const amountUnits = parseDecimalToUnits(amount, decimals)
    if (amountUnits === 0n || amountUnits > balance) {
        throw new Error(`Insufficient balance (need ${amountUnits}, have ${balance})`)
    }

    if (!extraOptions) {
        try {
            const enforcedOptionsMap = await oft.getEnforcedOptions(umi.rpc, effectiveStorePda, dstEid, programId)
            const enforcedOptionsBuffer = composeMsg ? enforcedOptionsMap.sendAndCall : enforcedOptionsMap.send
            if (isEmptyOptionsSolana(enforcedOptionsBuffer)) {
                const proceed = await promptToContinue(
                    'No extra options were included and OFT has no set enforced options. Your quote / send will most likely fail. Continue?'
                )
                if (!proceed) throw new Error('Aborted due to missing options')
            }
        } catch (error) {
            logger.debug(`Failed to check enforced options: ${error}`)
        }
    }

    const lookupTableAddresses =
        addressLookupTables && addressLookupTables.length > 0
            ? addressLookupTables.map((addr) => publicKey(addr))
            : [(await getDefaultAddressLookupTable(connection, umi, srcEid)).lookupTableAddress]

    logger.info('Quoting the native gas cost for the send transaction...')
    const sendParam = {
        dstEid,
        to: Buffer.from(addressToBytes32(to)),
        amountLd: amountUnits,
        minAmountLd: minAmount ? parseDecimalToUnits(minAmount, decimals) : amountUnits,
        options: extraOptions ? Buffer.from(extraOptions.replace(/^0x/, ''), 'hex') : undefined,
        composeMsg: composeMsg ? Buffer.from(composeMsg.replace(/^0x/, ''), 'hex') : undefined,
    }
    const { nativeFee } = await quoteNative(
        umi.rpc,
        { payer: umiWalletSigner.publicKey, tokenMint: fromWeb3JsPublicKey(mintPk) },
        { payInLzToken: false, ...sendParam },
        { oft: programId },
        [],
        lookupTableAddresses
    )

    logger.info('Sending the transaction...')
    const ix = await sendNative(
        umi.rpc,
        {
            payer: umiWalletSigner,
            tokenMint: fromWeb3JsPublicKey(mintPk),
            tokenSource: tokenAccount[0],
        },
        { nativeFee, ...sendParam },
        { oft: programId, token: tokenProgramId }
    )

    let txB = transactionBuilder().add([ix])
    txB = await addComputeUnitInstructions(
        connection,
        umi,
        srcEid,
        txB,
        umiWalletSigner,
        computeUnitPriceScaleFactor,
        TransactionType.SendOFT,
        lookupTableAddresses
    )
    let txHash: string
    try {
        const { signature } = await txB.sendAndConfirm(umi)
        txHash = bs58.encode(signature)
    } catch (error) {
        DebugLogger.printErrorAndFixSuggestion(
            KnownErrors.ERROR_QUOTING_NATIVE_GAS_COST,
            `For network: ${endpointIdToNetwork(srcEid)}, OFT: ${oftAddress}`
        )
        throw error
    }
    const isTestnet = srcEid === EndpointId.SOLANA_V2_TESTNET
    const scanLink = getLayerZeroScanLink(txHash, isTestnet)
    return { txHash, scanLink }
}
