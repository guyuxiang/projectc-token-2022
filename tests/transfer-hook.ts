import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  ExtensionType,
  burnChecked,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getPausableConfig,
  getPermanentDelegate,
  getTransferHook,
  pause,
  resume,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import type { TransferHook } from "../target/types/transfer_hook";

describe("transfer-hook extensions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TransferHook as Program<TransferHook>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const mint = Keypair.generate();
  const sourceOwner = Keypair.generate();
  const recipient = Keypair.generate();
  const outsider = Keypair.generate();

  const decimals = 6;
  const mintedAmount = 100_000n * 10n ** BigInt(decimals);
  const ownerTransferAmount = 1_000n * 10n ** BigInt(decimals);
  const delegateTransferAmount = 2_000n * 10n ** BigInt(decimals);
  const burnAmount = 500n * 10n ** BigInt(decimals);

  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    sourceOwner.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const outsiderTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    outsider.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [whiteListPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("white_list")],
    program.programId
  );

  async function sendTransfer(
    authority: PublicKey,
    signers: Keypair[],
    destination: PublicKey,
    amount: bigint
  ) {
    const instruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sourceTokenAccount,
      mint.publicKey,
      destination,
      authority,
      amount,
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const transaction = new Transaction().add(instruction);
    return sendAndConfirmTransaction(connection, transaction, signers, {
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

    return sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function removeFromWhitelist(tokenAccount: PublicKey) {
    const transaction = new Transaction().add(
      await (program.methods as any)
        .removeFromWhitelist()
        .accounts({
          accountToRemove: tokenAccount,
          signer: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    return sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
  }

  async function getAmount(tokenAccount: PublicKey): Promise<bigint> {
    const balance = await connection.getTokenAccountBalance(
      tokenAccount,
      "confirmed"
    );
    return BigInt(balance.value.amount);
  }

  it("creates a mint with TransferHook, Pausable, and PermanentDelegate extensions", async () => {
    const extensions = [
      ExtensionType.TransferHook,
      ExtensionType.PausableConfig,
      ExtensionType.PermanentDelegate,
    ];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(
      mintLen
    );

    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        wallet.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePausableConfigInstruction(
        mint.publicKey,
        wallet.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        wallet.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        decimals,
        wallet.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet.payer, mint],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );

    const mintInfo = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const transferHook = getTransferHook(mintInfo);
    const pausableConfig = getPausableConfig(mintInfo);
    const permanentDelegate = getPermanentDelegate(mintInfo);

    expect(transferHook?.authority.toBase58()).to.equal(
      wallet.publicKey.toBase58()
    );
    expect(transferHook?.programId.toBase58()).to.equal(
      program.programId.toBase58()
    );
    expect(pausableConfig?.authority.toBase58()).to.equal(
      wallet.publicKey.toBase58()
    );
    expect(pausableConfig?.paused).to.equal(false);
    expect(permanentDelegate?.delegate.toBase58()).to.equal(
      wallet.publicKey.toBase58()
    );
  });

  it("creates token accounts, mints supply, and initializes transfer-hook metadata", async () => {
    const tokenSetupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        sourceTokenAccount,
        sourceOwner.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destinationTokenAccount,
        recipient.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        outsiderTokenAccount,
        outsider.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        mint.publicKey,
        sourceTokenAccount,
        wallet.publicKey,
        mintedAmount,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tokenSetupTx, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const initializeExtraAccountMetaListInstruction = await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        mint: mint.publicKey,
      })
      .instruction();

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(initializeExtraAccountMetaListInstruction),
      [wallet.payer],
      { skipPreflight: true, commitment: "confirmed" }
    );

    expect(await getAmount(sourceTokenAccount)).to.equal(mintedAmount);
    expect(
      await connection.getAccountInfo(whiteListPda, "confirmed")
    ).to.not.equal(null);
  });

  it("enforces TransferHook with whitelist checks on both source and destination", async () => {
    await addToWhitelist(sourceTokenAccount);
    await addToWhitelist(destinationTokenAccount);

    const sourceBefore = await getAmount(sourceTokenAccount);
    const destinationBefore = await getAmount(destinationTokenAccount);

    await sendTransfer(
      sourceOwner.publicKey,
      [wallet.payer, sourceOwner],
      destinationTokenAccount,
      ownerTransferAmount
    );

    const sourceAfter = await getAmount(sourceTokenAccount);
    const destinationAfter = await getAmount(destinationTokenAccount);

    expect(sourceBefore - sourceAfter).to.equal(ownerTransferAmount);
    expect(destinationAfter - destinationBefore).to.equal(ownerTransferAmount);

    let threw = false;
    try {
      await sendTransfer(
        sourceOwner.publicKey,
        [wallet.payer, sourceOwner],
        outsiderTokenAccount,
        ownerTransferAmount
      );
    } catch (_error) {
      threw = true;
    }

    expect(threw).to.equal(true);
  });

  it("pauses and resumes token transfers via PausableConfig", async () => {
    await pause(
      connection,
      wallet.payer,
      mint.publicKey,
      wallet.payer,
      [],
      { skipPreflight: true, commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    let pausedTransferFailed = false;
    try {
      await sendTransfer(
        sourceOwner.publicKey,
        [wallet.payer, sourceOwner],
        destinationTokenAccount,
        ownerTransferAmount
      );
    } catch (_error) {
      pausedTransferFailed = true;
    }

    expect(pausedTransferFailed).to.equal(true);

    await resume(
      connection,
      wallet.payer,
      mint.publicKey,
      wallet.payer,
      [],
      { skipPreflight: true, commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const sourceBefore = await getAmount(sourceTokenAccount);
    const destinationBefore = await getAmount(destinationTokenAccount);

    await sendTransfer(
      sourceOwner.publicKey,
      [wallet.payer, sourceOwner],
      destinationTokenAccount,
      ownerTransferAmount
    );

    const sourceAfter = await getAmount(sourceTokenAccount);
    const destinationAfter = await getAmount(destinationTokenAccount);

    expect(sourceBefore - sourceAfter).to.equal(ownerTransferAmount);
    expect(destinationAfter - destinationBefore).to.equal(ownerTransferAmount);
  });

  it("allows the permanent delegate to transfer and burn without owner approval", async () => {
    const sourceBeforeTransfer = await getAmount(sourceTokenAccount);
    const destinationBeforeTransfer = await getAmount(destinationTokenAccount);

    await sendTransfer(
      wallet.publicKey,
      [wallet.payer],
      destinationTokenAccount,
      delegateTransferAmount
    );

    const sourceAfterTransfer = await getAmount(sourceTokenAccount);
    const destinationAfterTransfer = await getAmount(destinationTokenAccount);

    expect(sourceBeforeTransfer - sourceAfterTransfer).to.equal(
      delegateTransferAmount
    );
    expect(destinationAfterTransfer - destinationBeforeTransfer).to.equal(
      delegateTransferAmount
    );

    const mintBeforeBurn = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const sourceBeforeBurn = await getAmount(sourceTokenAccount);

    await burnChecked(
      connection,
      wallet.payer,
      sourceTokenAccount,
      mint.publicKey,
      wallet.payer,
      burnAmount,
      decimals,
      [],
      { skipPreflight: true, commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const mintAfterBurn = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const sourceAfterBurn = await getAmount(sourceTokenAccount);

    expect(sourceBeforeBurn - sourceAfterBurn).to.equal(burnAmount);
    expect(mintBeforeBurn.supply - mintAfterBurn.supply).to.equal(burnAmount);
  });

  it("fails transfers once the source account is removed from the whitelist", async () => {
    await removeFromWhitelist(sourceTokenAccount);

    let threw = false;
    try {
      await sendTransfer(
        sourceOwner.publicKey,
        [wallet.payer, sourceOwner],
        destinationTokenAccount,
        ownerTransferAmount
      );
    } catch (_error) {
      threw = true;
    }

    expect(threw).to.equal(true);
  });
});
