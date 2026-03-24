// @ts-nocheck
import 'dotenv/config'

import { transactionBuilder } from '@metaplex-foundation/umi'
import { lzReceive } from '@layerzerolabs/lz-solana-sdk-v2'
import bs58 from 'bs58'

import { deriveConnection } from './lib/solanaRuntime'
import { DEFAULTS, getScanMessage } from './utils'

async function main() {
    const txHash = process.env.TX_HASH
    const guid = process.env.GUID
    const message = await getScanMessage({ txHash, guid })

    if (Number(message.pathway?.dstEid) !== Number(process.env.LOCAL_EID || DEFAULTS.localEid)) {
        throw new Error(`Message destination eid ${message.pathway?.dstEid} does not match local Solana eid`)
    }

    if (message.destination?.status === 'SUCCEEDED') {
        console.log(`Message already executed on destination: ${message.destination?.tx?.txHash || message.guid}`)
        return
    }

    const { umi, umiWalletSigner } = await deriveConnection(DEFAULTS.localEid)
    const plan = await lzReceive(umi.rpc, umiWalletSigner.publicKey, {
        srcEid: Number(message.pathway.srcEid),
        sender: message.pathway.sender.address,
        receiver: message.pathway.receiver.address,
        nonce: BigInt(message.pathway.nonce),
        guid: message.guid,
        message: message.source?.tx?.payload,
    })

    let txBuilder = transactionBuilder()
    if ('instruction' in plan) {
        txBuilder = txBuilder.add({
            instruction: plan.instruction,
            signers: [umiWalletSigner],
            bytesCreatedOnChain: 0,
        })
    } else {
        txBuilder = txBuilder.setAddressLookupTables(plan.addressLookupTables)
        for (const ix of plan.instructions) {
            txBuilder = txBuilder.add({
                instruction: ix,
                signers: [umiWalletSigner, ...plan.signers],
                bytesCreatedOnChain: 0,
            })
        }
    }

    const receipt = await txBuilder.sendAndConfirm(umi)
    console.log(`retryTx=${bs58.encode(receipt.signature)}`)
    console.log(`guid=${message.guid}`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
