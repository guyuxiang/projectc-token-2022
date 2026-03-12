import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const WHITE_LIST_SEED = "white_list";
const FACTORY_SEED = "business-id-factory";
const BUSINESS_ID_RECORD_SEED = "business-id-record";
const CONFIG_SEED = "stablecoin-ramp-config";
const TOKEN_CONFIG_SEED = "stablecoin-ramp-token-config";
const VAULT_SEED = "stablecoin-ramp-vault";
const VAULT_AUTHORITY_SEED = "stablecoin-ramp-vault-authority";

describe("stablecoin-ramp", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const rampProgram = anchor.workspace.StablecoinRamp as anchor.Program<any>;
  const factoryProgram = anchor.workspace
    .BusinessIdFactory as anchor.Program<any>;
  const whitelistProgram = anchor.workspace
    .WhitelistManager as anchor.Program<any>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const user = Keypair.generate();
  const mint = Keypair.generate();
  const decimals = 6;
  const mintSupply = 2_000_000n * 10n ** BigInt(decimals);
  const depositAmount = 1_000_000n * 10n ** BigInt(decimals);
  const onRampAmount = 125_000n * 10n ** BigInt(decimals);
  const offRampAmount = 10_000n * 10n ** BigInt(decimals);

  const [whiteList] = PublicKey.findProgramAddressSync(
    [Buffer.from(WHITE_LIST_SEED), wallet.publicKey.toBuffer()],
    whitelistProgram.programId
  );
  const [factoryState] = PublicKey.findProgramAddressSync(
    [Buffer.from(FACTORY_SEED)],
    factoryProgram.programId
  );
  const [businessIdRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from(BUSINESS_ID_RECORD_SEED)],
    factoryProgram.programId
  );
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_SEED)],
    rampProgram.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_AUTHORITY_SEED)],
    rampProgram.programId
  );
  const [tokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(TOKEN_CONFIG_SEED), mint.publicKey.toBuffer()],
    rampProgram.programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), mint.publicKey.toBuffer()],
    rampProgram.programId
  );

  const treasuryTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    user.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  async function accountExists(pubkey: PublicKey) {
    return (await connection.getAccountInfo(pubkey, "confirmed")) !== null;
  }

  async function ensureWalletFunding(destination: PublicKey) {
    const balance = await connection.getBalance(destination, "confirmed");
    if (balance >= LAMPORTS_PER_SOL / 2) {
      return;
    }

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: destination,
          lamports: LAMPORTS_PER_SOL,
        })
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function ensureAssociatedTokenAccount(
    owner: PublicKey,
    tokenAccount: PublicKey
  ) {
    if (await accountExists(tokenAccount)) {
      return;
    }

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          tokenAccount,
          owner,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      ),
      [wallet.payer],
      {
        skipPreflight: true,
        commitment: "confirmed",
      }
    );
  }

  async function ensureWhitelist() {
    if (!(await accountExists(whiteList))) {
      await whitelistProgram.methods
        .initializeWhitelist()
        .accounts({
          authority: wallet.publicKey,
          whiteList,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    for (const entry of [wallet.publicKey, user.publicKey]) {
      await whitelistProgram.methods
        .addToWhitelist()
        .accounts({
          newAccount: entry,
          authority: wallet.publicKey,
          whiteList,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function ensureFactory() {
    if (await accountExists(factoryState)) {
      return;
    }

    await factoryProgram.methods
      .initializeFactory()
      .accounts({
        authority: wallet.publicKey,
        factoryState,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function ensureRampConfig() {
    if (!(await accountExists(config))) {
      await rampProgram.methods
        .initializeConfig(factoryProgram.programId, whiteList)
        .accounts({
          authority: wallet.publicKey,
          config,
          vaultAuthority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return;
    }

    await rampProgram.methods
      .updateConfig(factoryProgram.programId, whiteList)
      .accounts({
        authority: wallet.publicKey,
        config,
      })
      .rpc();
  }

  async function ensureMintAndLiquidity() {
    if (!(await accountExists(mint.publicKey))) {
      const rent = await connection.getMinimumBalanceForRentExemption(82);
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: mint.publicKey,
            lamports: rent,
            space: 82,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeMintInstruction(
            mint.publicKey,
            decimals,
            wallet.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
          )
        ),
        [wallet.payer, mint],
        {
          skipPreflight: true,
          commitment: "confirmed",
        }
      );
    }

    await ensureAssociatedTokenAccount(wallet.publicKey, treasuryTokenAccount);
    await ensureAssociatedTokenAccount(user.publicKey, userTokenAccount);

    const currentSupply = (
      await getMint(
        connection,
        mint.publicKey,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      )
    ).supply;

    if (currentSupply < mintSupply) {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createMintToInstruction(
            mint.publicKey,
            treasuryTokenAccount,
            wallet.publicKey,
            mintSupply - currentSupply,
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
    }

    await rampProgram.methods
      .registerToken("GLUSD", true)
      .accounts({
        authority: wallet.publicKey,
        config,
        mint: mint.publicKey,
        tokenConfig,
        vaultAuthority,
        vault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultBalance = (
      await getAccount(connection, vault, "confirmed", TOKEN_2022_PROGRAM_ID)
    ).amount;

    if (vaultBalance < depositAmount) {
      await rampProgram.methods
        .depositToken(new anchor.BN((depositAmount - vaultBalance).toString()))
        .accounts({
          authority: wallet.publicKey,
          config,
          mint: mint.publicKey,
          tokenConfig,
          vault,
          authorityTokenAccount: treasuryTokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    }
  }

  before(async () => {
    await ensureWalletFunding(user.publicKey);
    await ensureWhitelist();
    await ensureFactory();
    await ensureRampConfig();
    await ensureMintAndLiquidity();
  });

  it("creates on-ramp requests via CPI and persists the generated business id in the request", async () => {
    const request = Keypair.generate();
    const userBalanceBefore = (
      await getAccount(
        connection,
        userTokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;

    await rampProgram.methods
      .requestOnRamp(new anchor.BN(onRampAmount.toString()))
      .accounts({
        user: user.publicKey,
        config,
        whiteList,
        mint: mint.publicKey,
        tokenConfig,
        factoryState,
        businessIdFactoryProgram: factoryProgram.programId,
        businessIdRecord,
        request: request.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user, request])
      .rpc();

    const requestAccount = await rampProgram.account.rampRequest.fetch(
      request.publicKey
    );
    const recordAccount = await factoryProgram.account.businessIdRecord.fetch(
      businessIdRecord
    );

    expect(requestAccount.businessId).to.equal(recordAccount.refId);
    expect(requestAccount.businessId).to.match(/^20\d{12}GLUSDONRAMP\d{6,}$/);
    expect(requestAccount.status).to.deep.equal({ requestInitiated: {} });

    await rampProgram.methods
      .approveOnRamp()
      .accounts({
        authority: wallet.publicKey,
        config,
        whiteList,
        mint: mint.publicKey,
        tokenConfig,
        vaultAuthority,
        vault,
        request: request.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const approvedRequest = await rampProgram.account.rampRequest.fetch(
      request.publicKey
    );
    const userBalanceAfter = (
      await getAccount(
        connection,
        userTokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;

    expect(approvedRequest.status).to.deep.equal({ requestApproved: {} });
    expect(userBalanceAfter - userBalanceBefore).to.equal(onRampAmount);
  });

  it("overwrites the fixed business id record for off-ramp while preserving the old request id", async () => {
    const onRampRequest = Keypair.generate();
    await rampProgram.methods
      .requestOnRamp(new anchor.BN(onRampAmount.toString()))
      .accounts({
        user: user.publicKey,
        config,
        whiteList,
        mint: mint.publicKey,
        tokenConfig,
        factoryState,
        businessIdFactoryProgram: factoryProgram.programId,
        businessIdRecord,
        request: onRampRequest.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user, onRampRequest])
      .rpc();

    const beforeOverwrite = await rampProgram.account.rampRequest.fetch(
      onRampRequest.publicKey
    );
    const firstBusinessId = beforeOverwrite.businessId;

    await rampProgram.methods
      .approveOnRamp()
      .accounts({
        authority: wallet.publicKey,
        config,
        whiteList,
        mint: mint.publicKey,
        tokenConfig,
        vaultAuthority,
        vault,
        request: onRampRequest.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const offRampRequest = Keypair.generate();
    const mintSupplyBefore = (
      await getMint(
        connection,
        mint.publicKey,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      )
    ).supply;

    await rampProgram.methods
      .requestOffRamp(new anchor.BN(offRampAmount.toString()))
      .accounts({
        user: user.publicKey,
        config,
        whiteList,
        mint: mint.publicKey,
        tokenConfig,
        factoryState,
        businessIdFactoryProgram: factoryProgram.programId,
        businessIdRecord,
        request: offRampRequest.publicKey,
        vault,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user, offRampRequest])
      .rpc();

    const overwrittenRecord =
      await factoryProgram.account.businessIdRecord.fetch(businessIdRecord);
    const offRampRequestAccount = await rampProgram.account.rampRequest.fetch(
      offRampRequest.publicKey
    );
    const originalOnRampRequest = await rampProgram.account.rampRequest.fetch(
      onRampRequest.publicKey
    );

    expect(overwrittenRecord.refId).to.match(/^20\d{12}GLUSDOFFRAMP\d{6,}$/);
    expect(overwrittenRecord.refId).to.equal(offRampRequestAccount.businessId);
    expect(originalOnRampRequest.businessId).to.equal(firstBusinessId);
    expect(originalOnRampRequest.businessId).to.not.equal(
      overwrittenRecord.refId
    );

    await rampProgram.methods
      .approveOffRamp()
      .accounts({
        authority: wallet.publicKey,
        config,
        mint: mint.publicKey,
        tokenConfig,
        vaultAuthority,
        vault,
        request: offRampRequest.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const approvedOffRamp = await rampProgram.account.rampRequest.fetch(
      offRampRequest.publicKey
    );
    const mintSupplyAfter = (
      await getMint(
        connection,
        mint.publicKey,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      )
    ).supply;

    expect(approvedOffRamp.status).to.deep.equal({ requestApproved: {} });
    expect(mintSupplyBefore - mintSupplyAfter).to.equal(offRampAmount);
  });
});
