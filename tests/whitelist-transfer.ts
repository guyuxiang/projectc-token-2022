import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import type { TransferHook } from "../target/types/transfer_hook";

describe("transfer-hook whitelist transfer on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const GLUSD_MINT = new PublicKey(
    "7vyurtkGpjwmi4gmbWuPZHCTamqkDZrP1A6GAeDMMukR"
  );
  const DECIMALS = 6;
  const MINT_AMOUNT_UI = 1_000_000;
  const TRANSFER_AMOUNT_UI = 50_000;
  const MINT_AMOUNT = BigInt(MINT_AMOUNT_UI) * 10n ** BigInt(DECIMALS);
  const TRANSFER_AMOUNT = BigInt(TRANSFER_AMOUNT_UI) * 10n ** BigInt(DECIMALS);

  const userA = wallet.publicKey;
  const userB = Keypair.generate();
  const userC = Keypair.generate();

  const userATokenAccount = getAssociatedTokenAddressSync(
    GLUSD_MINT,
    userA,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const userBTokenAccount = getAssociatedTokenAddressSync(
    GLUSD_MINT,
    userB.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const userCTokenAccount = getAssociatedTokenAddressSync(
    GLUSD_MINT,
    userC.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  async function createAtaIfNeeded(owner: PublicKey, tokenAccount: PublicKey) {
    const accountInfo = await connection.getAccountInfo(
      tokenAccount,
      "confirmed"
    );
    if (accountInfo) {
      return;
    }

    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        tokenAccount,
        owner,
        GLUSD_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function addToWhitelist(tokenAccount: PublicKey) {
    const transaction = new Transaction().add(
      await program.methods
        .addToWhitelist()
        .accounts({
          newAccount: tokenAccount,
          signer: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function mintToA() {
    const transaction = new Transaction().add(
      createMintToInstruction(
        GLUSD_MINT,
        userATokenAccount,
        wallet.publicKey,
        MINT_AMOUNT,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function transferFromATo(destination: PublicKey) {
    const instruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      userATokenAccount,
      GLUSD_MINT,
      destination,
      wallet.publicKey,
      TRANSFER_AMOUNT,
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const transaction = new Transaction().add(instruction);
    return sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function getTokenAmount(tokenAccount: PublicKey): Promise<bigint> {
    const balance = await connection.getTokenAccountBalance(
      tokenAccount,
      "confirmed"
    );
    return BigInt(balance.value.amount);
  }

  it("creates ATA for A, B and C", async () => {
    await createAtaIfNeeded(userA, userATokenAccount);
    await createAtaIfNeeded(userB.publicKey, userBTokenAccount);
    await createAtaIfNeeded(userC.publicKey, userCTokenAccount);

    expect(
      await connection.getAccountInfo(userATokenAccount, "confirmed")
    ).to.not.equal(null);
    expect(
      await connection.getAccountInfo(userBTokenAccount, "confirmed")
    ).to.not.equal(null);
    expect(
      await connection.getAccountInfo(userCTokenAccount, "confirmed")
    ).to.not.equal(null);

    console.log(`userA: ${userA.toBase58()}`);
    console.log(`userA ATA: ${userATokenAccount.toBase58()}`);
    console.log(`userB: ${userB.publicKey.toBase58()}`);
    console.log(`userB ATA: ${userBTokenAccount.toBase58()}`);
    console.log(`userC: ${userC.publicKey.toBase58()}`);
    console.log(`userC ATA: ${userCTokenAccount.toBase58()}`);
  });

  it("adds A and B token accounts to the whitelist", async () => {
    await addToWhitelist(userATokenAccount);
    await addToWhitelist(userBTokenAccount);
  });

  it(`mints ${MINT_AMOUNT_UI.toLocaleString()} GLUSD to A`, async () => {
    const before = await getTokenAmount(userATokenAccount);
    await mintToA();
    const after = await getTokenAmount(userATokenAccount);

    expect(after - before).to.equal(MINT_AMOUNT);
    console.log(`minted to A: ${MINT_AMOUNT_UI} GLUSD`);
  });

  it(`transfers ${TRANSFER_AMOUNT_UI.toLocaleString()} GLUSD from A to B`, async () => {
    const aBefore = await getTokenAmount(userATokenAccount);
    const bBefore = await getTokenAmount(userBTokenAccount);

    const txSig = await transferFromATo(userBTokenAccount);

    const aAfter = await getTokenAmount(userATokenAccount);
    const bAfter = await getTokenAmount(userBTokenAccount);

    expect(aBefore - aAfter).to.equal(TRANSFER_AMOUNT);
    expect(bAfter - bBefore).to.equal(TRANSFER_AMOUNT);
    console.log(`A -> B transfer signature: ${txSig}`);
  });

  it(`fails to transfer ${TRANSFER_AMOUNT_UI.toLocaleString()} GLUSD from A to C`, async () => {
    const aBefore = await getTokenAmount(userATokenAccount);
    const cBefore = await getTokenAmount(userCTokenAccount);

    let threw = false;
    try {
      await transferFromATo(userCTokenAccount);
    } catch (error: any) {
      threw = true;
      console.log(
        `A -> C transfer rejected as expected: ${error?.message ?? error}`
      );
    }

    const aAfter = await getTokenAmount(userATokenAccount);
    const cAfter = await getTokenAmount(userCTokenAccount);

    expect(threw).to.equal(true);
    expect(aAfter).to.equal(aBefore);
    expect(cAfter).to.equal(cBefore);
  });
});
