import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  burnChecked,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
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
  const whitelistProgram = anchor.workspace.WhitelistManager as Program<any>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const mint = Keypair.generate();
  const secondMint = Keypair.generate();
  const sourceOwner = Keypair.generate();
  const recipient = Keypair.generate();
  const outsider = Keypair.generate();

  const decimals = 6;
  const mintedAmount = 100_000n * 10n ** BigInt(decimals);
  const ownerTransferAmount = 1_000n * 10n ** BigInt(decimals);
  const delegateTransferAmount = 2_000n * 10n ** BigInt(decimals);
  const burnAmount = 500n * 10n ** BigInt(decimals);

  const mintExtensions = [
    ExtensionType.TransferHook,
    ExtensionType.PausableConfig,
    ExtensionType.PermanentDelegate,
  ];

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
  const secondSourceTokenAccount = getAssociatedTokenAddressSync(
    secondMint.publicKey,
    sourceOwner.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const secondDestinationTokenAccount = getAssociatedTokenAddressSync(
    secondMint.publicKey,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [whiteListPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("white_list"), wallet.publicKey.toBuffer()],
    whitelistProgram.programId
  );

  async function createMintWithExtensions(mintKeypair: Keypair) {
    const mintLen = getMintLen(mintExtensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(
      mintLen
    );

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
          mintKeypair.publicKey,
          wallet.publicKey,
          program.programId,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializePausableConfigInstruction(
          mintKeypair.publicKey,
          wallet.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializePermanentDelegateInstruction(
          mintKeypair.publicKey,
          wallet.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
          mintKeypair.publicKey,
          decimals,
          wallet.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [wallet.payer, mintKeypair],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function initializeWhitelist() {
    const existing = await connection.getAccountInfo(whiteListPda, "confirmed");
    if (existing) {
      return;
    }

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        await whitelistProgram.methods
          .initializeWhitelist()
          .accounts({
            authority: wallet.publicKey,
            whiteList: whiteListPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function initializeHookMeta(mintAddress: PublicKey) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        await program.methods
          .initializeExtraAccountMetaList()
          .accounts({
            mint: mintAddress,
            whiteList: whiteListPda,
          })
          .instruction()
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function sendTransfer(
    mintAddress: PublicKey,
    source: PublicKey,
    authority: PublicKey,
    signers: Keypair[],
    destination: PublicKey,
    amount: bigint
  ) {
    const instruction = await createTransferCheckedWithTransferHookInstruction(
      connection,
      source,
      mintAddress,
      destination,
      authority,
      amount,
      decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    return sendAndConfirmTransaction(
      connection,
      new Transaction().add(instruction),
      signers,
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function addToWhitelist(tokenAccount: PublicKey) {
    return sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        await whitelistProgram.methods
          .addToWhitelist()
          .accounts({
            newAccount: tokenAccount,
            authority: wallet.publicKey,
            whiteList: whiteListPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function removeFromWhitelist(tokenAccount: PublicKey) {
    return sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        await whitelistProgram.methods
          .removeFromWhitelist()
          .accounts({
            accountToRemove: tokenAccount,
            authority: wallet.publicKey,
            whiteList: whiteListPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function getAmount(tokenAccount: PublicKey): Promise<bigint> {
    const balance = await connection.getTokenAccountBalance(
      tokenAccount,
      "confirmed"
    );
    return BigInt(balance.value.amount);
  }

  it("creates a mint with TransferHook, Pausable, and PermanentDelegate extensions", async () => {
    await createMintWithExtensions(mint);

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

  it("creates token accounts, mints supply, and initializes shared whitelist metadata", async () => {
    await initializeWhitelist();
    await createMintWithExtensions(secondMint);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
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
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          secondSourceTokenAccount,
          sourceOwner.publicKey,
          secondMint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          secondDestinationTokenAccount,
          recipient.publicKey,
          secondMint.publicKey,
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
        ),
        createMintToInstruction(
          secondMint.publicKey,
          secondSourceTokenAccount,
          wallet.publicKey,
          mintedAmount,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );

    await initializeHookMeta(mint.publicKey);
    await initializeHookMeta(secondMint.publicKey);

    expect(await getAmount(sourceTokenAccount)).to.equal(mintedAmount);
    expect(await getAmount(secondSourceTokenAccount)).to.equal(mintedAmount);
    expect(
      await connection.getAccountInfo(whiteListPda, "confirmed")
    ).to.not.equal(null);
  });

  it("lets multiple mints share the same whitelist program state", async () => {
    await addToWhitelist(sourceTokenAccount);
    await addToWhitelist(destinationTokenAccount);
    await addToWhitelist(secondSourceTokenAccount);
    await addToWhitelist(secondDestinationTokenAccount);

    const secondSourceBefore = await getAmount(secondSourceTokenAccount);
    const secondDestinationBefore = await getAmount(secondDestinationTokenAccount);

    await sendTransfer(
      secondMint.publicKey,
      secondSourceTokenAccount,
      sourceOwner.publicKey,
      [wallet.payer, sourceOwner],
      secondDestinationTokenAccount,
      ownerTransferAmount
    );

    const secondSourceAfter = await getAmount(secondSourceTokenAccount);
    const secondDestinationAfter = await getAmount(secondDestinationTokenAccount);

    expect(secondSourceBefore - secondSourceAfter).to.equal(ownerTransferAmount);
    expect(secondDestinationAfter - secondDestinationBefore).to.equal(
      ownerTransferAmount
    );
  });

  it("enforces TransferHook with whitelist checks on both source and destination", async () => {
    const sourceBefore = await getAmount(sourceTokenAccount);
    const destinationBefore = await getAmount(destinationTokenAccount);

    await sendTransfer(
      mint.publicKey,
      sourceTokenAccount,
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
        mint.publicKey,
        sourceTokenAccount,
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
        mint.publicKey,
        sourceTokenAccount,
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
      mint.publicKey,
      sourceTokenAccount,
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
      mint.publicKey,
      sourceTokenAccount,
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
        mint.publicKey,
        sourceTokenAccount,
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
