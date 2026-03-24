// @ts-nocheck
import 'dotenv/config'

import { ethers } from 'ethers'

import { sendSolana } from './lib/sendSolana'
import { useWeb3Js } from './lib/solanaRuntime'
import { parseDecimalToUnits } from './lib/solanaUtils'
import { DEFAULTS, getEnv, readSiblingEvmDeployment, readSolanaDeployment } from './utils'

async function solanaRpc(rpcUrl: string, method: string, params: unknown[]) {
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
        }),
    })
    const body = await response.json()
    if (body.error) {
        throw new Error(`Solana RPC ${method} failed: ${JSON.stringify(body.error)}`)
    }
    return body.result
}

async function getSolanaOwnerMintBalance(rpcUrl: string, owner: string, mint: string) {
    const result = await solanaRpc(rpcUrl, 'getTokenAccountsByOwner', [
        owner,
        { mint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])

    return result.value.reduce((sum: bigint, entry: any) => {
        const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0'
        return sum + BigInt(amount)
    }, 0n)
}

async function waitForEvmBalanceIncrease(params: {
    contract: ethers.Contract
    recipient: string
    before: bigint
    minDelta: bigint
    timeoutMs: number
    pollIntervalMs: number
}) {
    const { contract, recipient, before, minDelta, timeoutMs, pollIntervalMs } = params
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const current = BigInt((await contract.balanceOf(recipient)).toString())
        if (current >= before + minDelta) {
            return current
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(
        `Timed out waiting for Sepolia balance increase. before=${before} minDelta=${minDelta}`
    )
}

async function main() {
    const deployment = readSolanaDeployment(DEFAULTS.localEid) || {}
    const evmDeployment = readSiblingEvmDeployment() || {}
    const amount = getEnv('AMOUNT')
    const sepoliaRecipient = getEnv('SEPOLIA_RECIPIENT')
    const sepoliaRpcUrl = getEnv('SEPOLIA_RPC_URL', DEFAULTS.sepoliaRpcUrl)
    const sepoliaOftAddress = getEnv('SEPOLIA_OFT_ADDRESS', evmDeployment.proxy)
    const solanaRpcUrl = getEnv('SOLANA_RPC_URL', DEFAULTS.solanaRpcUrl)
    const solanaMint = getEnv('SOLANA_MINT', deployment.mint)
    const solanaOftStore = getEnv('SOLANA_OFT_STORE', deployment.oftStore)
    const solanaOftProgramId = getEnv('SOLANA_OFT_PROGRAM_ID', deployment.programId)
    const tokenProgram = getEnv('SOLANA_TOKEN_PROGRAM', deployment.tokenProgram || DEFAULTS.tokenProgram)
    const minAmount = process.env.MIN_AMOUNT || amount
    const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 5000)
    const timeoutMs = Number(process.env.TIMEOUT_MS || 10 * 60 * 1000)

    const { web3JsKeypair } = await useWeb3Js()
    const sourceOwner = web3JsKeypair.publicKey.toBase58()

    const provider =
        ethers.providers?.JsonRpcProvider != null
            ? new ethers.providers.JsonRpcProvider(sepoliaRpcUrl)
            : new ethers.JsonRpcProvider(sepoliaRpcUrl)
    const evmOft = new ethers.Contract(
        sepoliaOftAddress,
        [
            'function balanceOf(address account) view returns (uint256)',
            'function decimals() view returns (uint8)',
        ],
        provider
    )

    const decimals = Number(await evmOft.decimals())
    const minAmountLD = parseDecimalToUnits(minAmount, decimals)

    const srcBalanceBefore = await getSolanaOwnerMintBalance(solanaRpcUrl, sourceOwner, solanaMint)
    const dstBalanceBefore = BigInt((await evmOft.balanceOf(sepoliaRecipient)).toString())

    console.log('Source Solana balance before:', srcBalanceBefore.toString())
    console.log('Destination Sepolia balance before:', dstBalanceBefore.toString())

    const result = await sendSolana({
        amount,
        minAmount,
        to: sepoliaRecipient,
        srcEid: DEFAULTS.localEid,
        dstEid: DEFAULTS.remoteEid,
        oftAddress: solanaOftStore,
        oftProgramId: solanaOftProgramId,
        tokenProgram,
    })

    console.log('Source tx hash:', result.txHash)
    console.log('LayerZero Scan:', result.scanLink)

    const dstBalanceAfter = await waitForEvmBalanceIncrease({
        contract: evmOft,
        recipient: sepoliaRecipient,
        before: dstBalanceBefore,
        minDelta: minAmountLD,
        timeoutMs,
        pollIntervalMs,
    })
    const srcBalanceAfter = await getSolanaOwnerMintBalance(solanaRpcUrl, sourceOwner, solanaMint)

    console.log('Source Solana balance after:', srcBalanceAfter.toString())
    console.log('Destination Sepolia balance after:', dstBalanceAfter.toString())
    console.log('Validated destination balance increase:', (dstBalanceAfter - dstBalanceBefore).toString())
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
