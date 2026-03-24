// @ts-nocheck
import { ComputeBudgetProgram } from '@solana/web3.js'
import {
    AccountMeta,
    PublicKey,
    RpcInterface,
    Signer,
    WrappedInstruction,
    publicKey,
    transactionBuilder,
} from '@metaplex-foundation/umi'
import { toWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'

import {
    EndpointProgram,
    EventPDA,
    MessageLibInterface,
    SimpleMessageLibProgram,
    SolanaPacketPath,
    UlnProgram,
    simulateWeb3JsTransaction,
} from '@layerzerolabs/lz-solana-sdk-v2/umi'
import { OftPDA, oft302 } from '@layerzerolabs/oft-v2-solana-sdk'

const ENDPOINT_PROGRAM_ID: PublicKey = EndpointProgram.ENDPOINT_PROGRAM_ID
const { createOFTProgramRepo, accounts: OFTAccounts, instructions, types } = oft302
const { getSendInstructionDataSerializer, getInitOftInstructionDataSerializer } = instructions

export function deriveNativeOftStore(oftProgramId: PublicKey, mint: PublicKey): [PublicKey, number] {
    return new OftPDA(oftProgramId).oftStore(mint)
}

export function deriveNativePeer(oftProgramId: PublicKey, oftStore: PublicKey, eid: number): [PublicKey, number] {
    return new OftPDA(oftProgramId).peer(oftStore, eid)
}

export function deriveNativeLzReceiveTypes(oftProgramId: PublicKey, oftStore: PublicKey): [PublicKey, number] {
    return new OftPDA(oftProgramId).lzReceiveTypesAccounts(oftStore)
}

export function initNativeOft(
    accounts: { payer: Signer; admin: PublicKey; mint: PublicKey },
    params: { sharedDecimals?: number; tokenProgram?: PublicKey; endpointProgram?: PublicKey },
    programs: { oft: PublicKey }
): WrappedInstruction {
    const tokenProgram = params.tokenProgram ?? publicKey(TOKEN_PROGRAM_ID.toBase58())
    const endpointProgram = params.endpointProgram ?? ENDPOINT_PROGRAM_ID
    const programsRepo = createOFTProgramRepo(programs.oft)
    const endpoint = new EndpointProgram.Endpoint(endpointProgram)
    const [oftStore] = deriveNativeOftStore(programs.oft, accounts.mint)
    const [lzReceiveTypes] = deriveNativeLzReceiveTypes(programs.oft, oftStore)

    const keys: AccountMeta[] = [
        { pubkey: accounts.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: oftStore, isSigner: false, isWritable: true },
        { pubkey: lzReceiveTypes, isSigner: false, isWritable: true },
        { pubkey: accounts.mint, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: publicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ]
    const data = getInitOftInstructionDataSerializer().serialize({
        oftType: types.OFTType.Native,
        admin: accounts.admin,
        sharedDecimals: params.sharedDecimals ?? 6,
        endpointProgram,
    })
    const ix = transactionBuilder([
        {
            instruction: { programId: programsRepo.getPublicKey('oft', ''), keys, data },
            signers: [accounts.payer],
            bytesCreatedOnChain: 0,
        },
    ])
    return ix
        .addRemainingAccounts(
            endpoint.getRegisterOappIxAccountMetaForCPI(accounts.payer.publicKey, oftStore).map((acc) => ({
                pubkey: acc.pubkey,
                isSigner: acc.isSigner,
                isWritable: acc.isWritable,
            }))
        )
        .items[0]
}

export async function quoteNative(
    rpc: RpcInterface,
    accounts: { payer: PublicKey; tokenMint: PublicKey; peerAddr?: Uint8Array },
    quoteParams: {
        dstEid: number
        to: Uint8Array
        amountLd: bigint
        minAmountLd: bigint
        options?: Uint8Array
        payInLzToken?: boolean
        composeMsg?: Uint8Array
    },
    programs: { oft: PublicKey; endpoint?: PublicKey },
    remainingAccounts?: AccountMeta[],
    addressLookupTables?: PublicKey | PublicKey[]
): Promise<{ nativeFee: bigint; lzTokenFee: bigint }> {
    const { dstEid, to, amountLd, minAmountLd, options, payInLzToken, composeMsg } = quoteParams
    const { payer, tokenMint } = accounts
    const [oftStore] = deriveNativeOftStore(programs.oft, tokenMint)
    const [peer] = deriveNativePeer(programs.oft, oftStore, dstEid)

    if (remainingAccounts == null || remainingAccounts.length === 0) {
        const peerAddr =
            accounts.peerAddr ?? (await OFTAccounts.fetchPeerConfig({ rpc }, peer).then((peerInfo) => peerInfo.peerAddress))
        const endpoint = new EndpointProgram.Endpoint(programs.endpoint ?? ENDPOINT_PROGRAM_ID)
        const messageLib = await getSendLibraryProgram(rpc, endpoint, payer, oftStore, dstEid)
        remainingAccounts = await endpoint.getQuoteIXAccountMetaForCPI(rpc, payer, {
            path: { sender: oftStore, dstEid, receiver: peerAddr },
            msgLibProgram: messageLib,
        })
    }

    const txBuilder = instructions
        .quoteSend(
            { programs: createOFTProgramRepo(programs.oft) },
            {
                oftStore,
                peer,
                tokenMint,
                dstEid,
                to,
                amountLd,
                minAmountLd,
                options: options ?? new Uint8Array(),
                payInLzToken: payInLzToken ?? false,
                composeMsg: composeMsg ?? null,
            }
        )
        .addRemainingAccounts(remainingAccounts)

    const web3Ix = toWeb3JsInstruction(txBuilder.getInstructions()[0])
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })
    return simulateWeb3JsTransaction(
        rpc,
        [modifyComputeUnits, web3Ix],
        web3Ix.programId,
        toWeb3JsPublicKey(payer),
        EndpointProgram.types.getMessagingFeeSerializer(),
        'confirmed',
        undefined,
        addressLookupTables !== undefined
            ? Array.isArray(addressLookupTables)
                ? addressLookupTables.map(toWeb3JsPublicKey)
                : toWeb3JsPublicKey(addressLookupTables)
            : undefined
    )
}

export async function sendNative(
    rpc: RpcInterface,
    accounts: { payer: Signer; tokenMint: PublicKey; tokenSource: PublicKey; peerAddr?: Uint8Array },
    sendParams: {
        dstEid: number
        to: Uint8Array
        amountLd: bigint
        minAmountLd: bigint
        options?: Uint8Array
        composeMsg?: Uint8Array
        nativeFee: bigint
        lzTokenFee?: bigint
    },
    programs: { oft: PublicKey; endpoint?: PublicKey; token?: PublicKey },
    remainingAccounts?: AccountMeta[]
): Promise<WrappedInstruction> {
    const { payer, tokenMint, tokenSource } = accounts
    const { dstEid, to, amountLd, minAmountLd, options, composeMsg, nativeFee, lzTokenFee } = sendParams
    const [oftStore] = deriveNativeOftStore(programs.oft, tokenMint)
    const [peer] = deriveNativePeer(programs.oft, oftStore, dstEid)

    if (remainingAccounts == null || remainingAccounts.length === 0) {
        const peerAddr =
            accounts.peerAddr ?? (await OFTAccounts.fetchPeerConfig({ rpc }, peer).then((peerInfo) => peerInfo.peerAddress))
        const endpoint = new EndpointProgram.Endpoint(programs.endpoint ?? ENDPOINT_PROGRAM_ID)
        const msgLibProgram = await getSendLibraryProgram(rpc, endpoint, payer.publicKey, oftStore, dstEid)
        const packetPath: SolanaPacketPath = { dstEid, sender: oftStore, receiver: peerAddr }
        remainingAccounts = await endpoint.getSendIXAccountMetaForCPI(rpc, payer.publicKey, {
            path: packetPath,
            msgLibProgram,
        })
    }

    const [eventAuthorityPDA] = new EventPDA(programs.oft).eventAuthority()
    const tokenProgram = programs.token ?? publicKey(TOKEN_PROGRAM_ID.toBase58())
    const ix = transactionBuilder([
        {
            instruction: {
                programId: createOFTProgramRepo(programs.oft).getPublicKey('oft', ''),
                keys: [
                    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
                    { pubkey: peer, isSigner: false, isWritable: true },
                    { pubkey: oftStore, isSigner: false, isWritable: true },
                    { pubkey: tokenSource, isSigner: false, isWritable: true },
                    { pubkey: tokenMint, isSigner: false, isWritable: true },
                    { pubkey: tokenProgram, isSigner: false, isWritable: false },
                    { pubkey: eventAuthorityPDA, isSigner: false, isWritable: false },
                    { pubkey: programs.oft, isSigner: false, isWritable: false },
                ],
                data: getSendInstructionDataSerializer().serialize({
                    dstEid,
                    to,
                    amountLd,
                    minAmountLd,
                    options: options ?? new Uint8Array(),
                    composeMsg: composeMsg ?? null,
                    nativeFee,
                    lzTokenFee: lzTokenFee ?? 0n,
                }),
            },
            signers: [payer],
            bytesCreatedOnChain: 0,
        },
    ])

    return ix
        .addRemainingAccounts(
            remainingAccounts.map((acc) => ({
                pubkey: acc.pubkey,
                isSigner: acc.isSigner,
                isWritable: acc.isWritable,
            }))
        )
        .items[0]
}

async function getSendLibraryProgram(
    rpc: RpcInterface,
    endpoint: EndpointProgram.Endpoint,
    payer: PublicKey,
    oftStore: PublicKey,
    dstEid: number
): Promise<MessageLibInterface> {
    const sendLibInfo = await endpoint.getSendLibrary(rpc, oftStore, dstEid)
    const version = await endpoint.getMessageLibVersion(rpc, payer, sendLibInfo.programId)
    if (version?.major === 3n && version.minor === 0 && version.endpointVersion === 2) {
        return new UlnProgram.Uln(sendLibInfo.programId)
    }
    return new SimpleMessageLibProgram.SimpleMessageLib(sendLibInfo.programId)
}

export interface NativeOftDeployment {
    programId: string
    mint: string
    mintAuthority?: string
    oftStore: string
    escrow?: string
}
