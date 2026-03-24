// @ts-nocheck
import 'dotenv/config'

import { DEFAULTS, getScanMessage } from './utils'

function printSection(title: string, value: unknown) {
    console.log(`${title}:`, value ?? 'N/A')
}

async function main() {
    const txHash = process.env.TX_HASH
    const guid = process.env.GUID
    const message = await getScanMessage({ txHash, guid })

    printSection('GUID', message.guid)
    printSection('Path', `${message.pathway.srcEid} -> ${message.pathway.dstEid}`)
    printSection('Source Sender', message.pathway.sender?.address)
    printSection('Destination Receiver', message.pathway.receiver?.address)
    printSection('Source Tx', message.source?.tx?.txHash)
    printSection('Destination Tx', message.destination?.tx?.txHash)
    printSection('Overall Status', `${message.status?.name}: ${message.status?.message || ''}`.trim())
    printSection('Source Status', message.source?.status)
    printSection('Destination Status', message.destination?.status)
    printSection('DVN Status', message.verification?.dvn?.status)
    printSection('Sealer Status', message.verification?.sealer?.status)
    printSection('Config Error', message.config?.error ? message.config?.errorMessage || true : false)
    printSection(
        'LayerZero Scan',
        `https://testnet.layerzeroscan.com/tx/${message.source?.tx?.txHash || txHash || ''}`
    )

    if (Number(message.pathway?.dstEid) !== Number(process.env.LOCAL_EID || DEFAULTS.localEid)) {
        console.log(
            `Note: this workspace is configured for local EID ${process.env.LOCAL_EID || DEFAULTS.localEid}, but the message destination is ${message.pathway?.dstEid}`
        )
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
