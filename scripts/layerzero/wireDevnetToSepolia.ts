// @ts-nocheck
import 'dotenv/config'

import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import { ethers } from 'ethers'
import { Options } from '@layerzerolabs/lz-v2-utilities'
import { oft302 } from '@layerzerolabs/oft-v2-solana-sdk'

import { deriveConnection } from './lib/solanaRuntime'
import { DEFAULTS, getEnv, readSiblingEvmDeployment, readSolanaDeployment, runHardhatTask, writeSolanaDeployment } from './utils'
import { addressToBytes32 } from '@layerzerolabs/lz-v2-utilities'
import { EndpointProgram } from '@layerzerolabs/lz-solana-sdk-v2/umi'

function toBytes32Address(address: string): Uint8Array {
    return Uint8Array.from(Buffer.from(ethers.utils.hexZeroPad(address, 32).slice(2), 'hex'))
}

async function main() {
    const deployment = readSolanaDeployment(DEFAULTS.localEid)
    if (!deployment?.oftStore || !deployment?.programId) {
        throw new Error(`Missing deployment file: deployments/solana-testnet/OFT.json`)
    }
    const evmDeployment = readSiblingEvmDeployment() || {}
    const remoteOApp = getEnv('SEPOLIA_OFT_ADDRESS', evmDeployment.proxy)
    const remoteEid = Number(process.env.REMOTE_EID || DEFAULTS.remoteEid)
    const sendGas = BigInt(process.env.SEPOLIA_RECEIVE_GAS || DEFAULTS.solanaToEvmGas)
    const sendValue = BigInt(process.env.SEPOLIA_RECEIVE_VALUE || DEFAULTS.solanaToEvmValue)
    const sendOptions =
        process.env.SEND_OPTIONS || new Options().addExecutorLzReceiveOption(sendGas, sendValue).toHex()
    const sendAndCallOptions = process.env.SEND_AND_CALL_OPTIONS || sendOptions

    runHardhatTask(['lz:oft:solana:init-config', '--oapp-config', 'layerzero.config.ts'], {
        EVM_OFT_ADDRESS: remoteOApp,
        SOLANA_OFT_STORE: deployment.oftStore,
    })

    const programId = publicKey(deployment.programId)
    const oftStore = publicKey(deployment.oftStore)
    const { umi, umiWalletSigner } = await deriveConnection(DEFAULTS.localEid)

    const setPeerIx = oft302.setPeerConfig(
        {
            admin: umiWalletSigner,
            oftStore,
        },
        {
            remote: remoteEid,
            __kind: 'PeerAddress',
            peer: toBytes32Address(remoteOApp),
        },
        programId
    )

    const enforcedIx = oft302.setPeerConfig(
        {
            admin: umiWalletSigner,
            oftStore,
        },
        {
            remote: remoteEid,
            __kind: 'EnforcedOptions',
            send: Uint8Array.from(Buffer.from(sendOptions.replace(/^0x/, ''), 'hex')),
            sendAndCall: Uint8Array.from(Buffer.from(sendAndCallOptions.replace(/^0x/, ''), 'hex')),
        },
        programId
    )

    const peerReceipt = await transactionBuilder().add(setPeerIx).add(enforcedIx).sendAndConfirm(umi)
    console.log(`configurePeerTx=${peerReceipt.signature}`)

    const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID)
    const remoteOAppBytes = Buffer.from(addressToBytes32(remoteOApp))
    const [noncePda] = endpoint.pda.nonce(oftStore, remoteEid, remoteOAppBytes)
    const [pendingNoncePda] = endpoint.pda.pendingNonce(oftStore, remoteEid, remoteOAppBytes)
    const nonceInfo = await umi.rpc.getAccount(noncePda)
    const pendingNonceInfo = await umi.rpc.getAccount(pendingNoncePda)

    let nonceTxHash: string | null = null
    if (!nonceInfo.exists || !pendingNonceInfo.exists) {
        const ix = endpoint.initOAppNonce(umiWalletSigner, {
            localOApp: oftStore,
            remote: remoteEid,
            remoteOApp: remoteOAppBytes,
        })
        const receipt = await transactionBuilder().add(ix).sendAndConfirm(umi)
        nonceTxHash = receipt.signature
        console.log(`initNativeNonceTx=${receipt.signature}`)
    } else {
        console.log(`nonce already exists: ${noncePda}`)
    }

    writeSolanaDeployment(DEFAULTS.localEid, {
        ...deployment,
        remote: {
            eid: remoteEid,
            peer: remoteOApp,
            sendOptions,
            sendAndCallOptions,
        },
        initConfigCompleted: true,
        configurePeerTxHash: peerReceipt.signature,
        nonceTxHash,
    })

    console.log(`oftStore=${deployment.oftStore}`)
    console.log(`remotePeer=${remoteOApp}`)
    console.log(`sendOptions=${sendOptions}`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
