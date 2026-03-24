import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'

export const DEFAULTS = {
    localEid: EndpointId.SOLANA_V2_TESTNET,
    remoteEid: EndpointId.SEPOLIA_V2_TESTNET,
    scanApiBase: 'https://scan-testnet.layerzero-api.com/v1',
    solanaRpcUrl: 'https://solana-devnet.g.alchemy.com/v2/ctfqrNoJ-i8cb99lEfS-Xpt57IDzQmwQ',
    sepoliaRpcUrl: 'https://sepolia.gateway.tenderly.co/65VPkX3BEXAlx0MQDjKgF7',
    oftProgramId: 'FRFcWRhoNmayfare3Y5SMEocXSjwKpmBtCCPLXWJukfR',
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    evmToSolanaGas: 200000n,
    evmToSolanaValue: 2039280n,
    solanaToEvmGas: 80000n,
    solanaToEvmValue: 0n,
}

export function getEnv(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

export function readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
        return null
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export function writeJson(filePath: string, data: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

export function getSolanaDeploymentPath(eid: EndpointId = DEFAULTS.localEid) {
    return path.join(process.cwd(), 'deployments', endpointIdToNetwork(eid), 'OFT.json')
}

export function readSolanaDeployment(
    eid: EndpointId = DEFAULTS.localEid
): Partial<{
    programId: string
    mint: string
    mintAuthority: string
    oftStore: string
    remote: {
        eid: number
        peer: string
        sendOptions: string
        sendAndCallOptions: string
    }
}> | null {
    return readJson(getSolanaDeploymentPath(eid))
}

export function writeSolanaDeployment(eid: EndpointId, data: unknown) {
    writeJson(getSolanaDeploymentPath(eid), data)
}

export function readSiblingEvmDeployment(): Partial<{
    proxy: string
    endpointV2: string
    remote: {
        eid: number
        peer: string
        enforcedOptions: string
    }
}> | null {
    return readJson(
        path.join(process.cwd(), '..', 'projectc-oft-evm', 'deployments', 'sepolia', 'OFT.json')
    )
}

export function runHardhatTask(args: string[], extraEnv: Record<string, string>) {
    execFileSync('./node_modules/.bin/hardhat', args, {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
            ...process.env,
            ...extraEnv,
        },
    })
}

export async function scanApi<T = any>(pathname: string): Promise<T> {
    const baseUrl = process.env.LZ_SCAN_API_BASE || DEFAULTS.scanApiBase
    const response = await fetch(`${baseUrl}${pathname}`)
    if (!response.ok) {
        throw new Error(`LayerZero Scan API failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
}

export async function getScanMessage(params: { txHash?: string; guid?: string }) {
    const { txHash, guid } = params
    if (!txHash && !guid) {
        throw new Error('Missing TX_HASH or GUID')
    }
    const pathname = txHash ? `/messages/tx/${txHash}` : `/messages/guid/${guid}`
    const body = await scanApi<{ data?: any[] }>(pathname)
    const message = body?.data?.[0]
    if (!message) {
        throw new Error(`LayerZero Scan message not found for ${txHash || guid}`)
    }
    return message
}
