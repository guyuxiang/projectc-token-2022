use crate::*;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as ENDPOINT_ID};
use crate::token_2022_compat::Token2022MintCompat;

#[derive(Accounts)]
pub struct InitOFT<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + OFTStore::INIT_SPACE,
        seeds = [OFT_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub oft_store: Account<'info, OFTStore>,
    #[account(
        init,
        payer = payer,
        space = 8 + LzReceiveTypesAccounts::INIT_SPACE,
        seeds = [LZ_RECEIVE_TYPES_SEED, oft_store.key().as_ref()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    pub token_mint: InterfaceAccount<'info, Token2022MintCompat>,
    /// CHECK: retained only so Anchor validates the token program owner of `token_mint`
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl InitOFT<'_> {
    pub fn apply(ctx: &mut Context<InitOFT>, params: &InitOFTParams) -> Result<()> {
        require!(params.oft_type == OFTType::Native, OFTError::Unauthorized);
        // Initialize the oft_store
        ctx.accounts.oft_store.oft_type = params.oft_type.clone();
        require!(
            ctx.accounts.token_mint.decimals >= params.shared_decimals,
            OFTError::InvalidDecimals
        );
        ctx.accounts.oft_store.ld2sd_rate =
            10u64.pow((ctx.accounts.token_mint.decimals - params.shared_decimals) as u32);
        ctx.accounts.oft_store.token_mint = ctx.accounts.token_mint.key();
        ctx.accounts.oft_store.endpoint_program =
            if let Some(endpoint_program) = params.endpoint_program {
                endpoint_program
            } else {
                ENDPOINT_ID
            };
        ctx.accounts.oft_store.bump = ctx.bumps.oft_store;
        ctx.accounts.oft_store.admin = params.admin;
        ctx.accounts.oft_store.paused = false;
        ctx.accounts.oft_store.pauser = None;
        ctx.accounts.oft_store.unpauser = None;

        // Initialize the lz_receive_types_accounts
        ctx.accounts.lz_receive_types_accounts.oft_store = ctx.accounts.oft_store.key();
        ctx.accounts.lz_receive_types_accounts.token_mint = ctx.accounts.token_mint.key();

        // Register the oapp
        oapp::endpoint_cpi::register_oapp(
            ctx.accounts.oft_store.endpoint_program,
            ctx.accounts.oft_store.key(),
            ctx.remaining_accounts,
            &[OFT_SEED, ctx.accounts.token_mint.key().as_ref(), &[ctx.bumps.oft_store]],
            RegisterOAppParams { delegate: params.admin },
        )
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitOFTParams {
    pub oft_type: OFTType,
    pub admin: Pubkey,
    pub shared_decimals: u8,
    pub endpoint_program: Option<Pubkey>,
}
