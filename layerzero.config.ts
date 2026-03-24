import fs from 'node:fs'
import path from 'node:path'

import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

function readDeployment<T>(deploymentPath: string): T | null {
    if (!fs.existsSync(deploymentPath)) {
        return null
    }
    return JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as T
}

const evmDeployment = readDeployment<{ proxy: string }>(
    path.join(__dirname, '..', 'projectc-oft-evm', 'deployments', 'sepolia', 'OFT.json')
)
const solanaDeployment = readDeployment<{ oftStore: string }>(
    path.join(__dirname, 'deployments', 'solana-testnet', 'OFT.json')
)

const evmContract: OmniPointHardhat = {
    eid: Number(process.env.EVM_OFT_EID || EndpointId.SEPOLIA_V2_TESTNET),
    address: process.env.EVM_OFT_ADDRESS || evmDeployment?.proxy,
}

const solanaContract: OmniPointHardhat = {
    eid: Number(process.env.SOLANA_OFT_EID || EndpointId.SOLANA_V2_TESTNET),
    address: process.env.SOLANA_OFT_STORE || solanaDeployment?.oftStore,
}

const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 80000,
        value: 0,
    },
]

const CU_LIMIT = 200000 // This represents the CU limit for executing the `lz_receive` function on Solana.
const SPL_TOKEN_ACCOUNT_RENT_VALUE = 2039280 // This figure represents lamports (https://solana.com/docs/references/terminology#lamport) on Solana. Read below for more details.
/*
 *  Elaboration on `value` when sending OFTs to Solana:
 *   When sending OFTs to Solana, SOL is needed for rent (https://solana.com/docs/core/accounts#rent) to initialize the recipient's token account.
 *   The `2039280` lamports value is the exact rent value needed for SPL token accounts (0.00203928 SOL).
 *   For Token2022 token accounts, you will need to increase `value` to a higher amount, which depends on the token account size, which in turn depends on the extensions that you enable.
 */

const SOLANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: CU_LIMIT,
        value: SPL_TOKEN_ACCOUNT_RENT_VALUE,
    },
]

// Learn about Message Execution Options: https://docs.layerzero.network/v2/developers/solana/oft/overview#message-execution-options
// Learn more about the Simple Config Generator - https://docs.layerzero.network/v2/developers/evm/technical-reference/simple-config
export default async function () {
    const connections = await generateConnectionsConfig([
        [
            evmContract,
            solanaContract,
            [['LayerZero Labs'], []],
            [15, 32],
            [SOLANA_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
        ],
    ])

    return {
        contracts: [{ contract: evmContract }, { contract: solanaContract }],
        connections,
    }
}
