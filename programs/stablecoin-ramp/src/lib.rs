use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use business_id_factory::{
    cpi, program::BusinessIdFactory, BusinessIdRecord, FactoryState,
    RequestType as BusinessIdRequestType,
};
use whitelist_manager::state::WhiteList;

declare_id!("Gov4oxrHdeDw7XihXKYRzq67aoJCrfhzumybUfDqHGmF");

const CONFIG_SEED: &[u8] = b"stablecoin-ramp-config";
const VAULT_AUTHORITY_SEED: &[u8] = b"stablecoin-ramp-vault-authority";
const TOKEN_CONFIG_SEED: &[u8] = b"stablecoin-ramp-token-config";
const VAULT_SEED: &[u8] = b"stablecoin-ramp-vault";
const BUSINESS_ID_RECORD_SEED: &[u8] = b"business-id-record";
const MAX_SYMBOL_LEN: usize = 16;
const MAX_BUSINESS_ID_LEN: usize = 64;

#[program]
pub mod stablecoin_ramp {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        business_id_factory: Pubkey,
        whitelist: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.business_id_factory = business_id_factory;
        config.whitelist = whitelist;
        config.paused = false;
        config.vault_authority_bump = ctx.bumps.vault_authority;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        business_id_factory: Pubkey,
        whitelist: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.business_id_factory = business_id_factory;
        config.whitelist = whitelist;
        Ok(())
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn register_token(
        ctx: Context<RegisterToken>,
        symbol: String,
        is_self_issued: bool,
    ) -> Result<()> {
        validate_symbol(&symbol)?;

        let token_config = &mut ctx.accounts.token_config;
        token_config.authority = ctx.accounts.authority.key();
        token_config.mint = ctx.accounts.mint.key();
        token_config.token_program = ctx.accounts.token_program.key();
        token_config.vault = ctx.accounts.vault.key();
        token_config.symbol = symbol.clone();
        token_config.enabled = true;
        token_config.is_self_issued = is_self_issued;

        emit!(TokenRegistered {
            mint: token_config.mint,
            token_program: token_config.token_program,
            vault: token_config.vault,
            symbol,
            is_self_issued,
        });

        Ok(())
    }

    pub fn request_on_ramp(ctx: Context<RequestOnRamp>, amount: u64) -> Result<()> {
        require!(amount > 0, StablecoinRampError::InvalidAmount);
        assert_not_paused(&ctx.accounts.config)?;
        assert_whitelisted(&ctx.accounts.white_list, &ctx.accounts.user.key())?;
        let business_id_record = reserve_business_id_via_cpi(
            &ctx.accounts.business_id_factory_program,
            &ctx.accounts.factory_state,
            &ctx.accounts.user,
            &ctx.accounts.business_id_record,
            &ctx.accounts.system_program,
            &ctx.accounts.token_config.symbol,
            BusinessIdRequestType::OnRamp,
        )?;
        assert_business_id_record(
            &ctx.accounts.factory_state,
            &ctx.accounts.token_config,
            &business_id_record,
            BusinessIdRequestType::OnRamp,
        )?;

        fill_request(
            &mut ctx.accounts.request,
            &ctx.accounts.user.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.user_token_account.key(),
            amount,
            RampRequestType::OnRamp,
            RampRequestStatus::RequestInitiated,
            &business_id_record.ref_id,
        )?;

        emit!(RampRequested {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount,
            request_type: RampRequestType::OnRamp,
        });

        Ok(())
    }

    pub fn approve_on_ramp(ctx: Context<ProcessOnRamp>) -> Result<()> {
        assert_not_paused(&ctx.accounts.config)?;
        assert_whitelisted(&ctx.accounts.white_list, &ctx.accounts.request.requester)?;
        assert_request_pending(&ctx.accounts.request, RampRequestType::OnRamp)?;

        let signer_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            &[ctx.accounts.config.vault_authority_bump],
        ];
        let decimals = ctx.accounts.mint.decimals;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            ctx.accounts.request.amount,
            decimals,
        )?;

        mark_request_processed(&mut ctx.accounts.request, RampRequestStatus::RequestApproved)?;

        emit!(RampProcessed {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount: ctx.accounts.request.amount,
            request_type: RampRequestType::OnRamp,
            status: RampRequestStatus::RequestApproved,
        });

        Ok(())
    }

    pub fn reject_on_ramp(ctx: Context<RejectRequest>, reason: String) -> Result<()> {
        assert_request_pending(&ctx.accounts.request, RampRequestType::OnRamp)?;
        mark_request_processed(&mut ctx.accounts.request, RampRequestStatus::RequestRejected)?;

        emit!(RampRejected {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount: ctx.accounts.request.amount,
            request_type: RampRequestType::OnRamp,
            reason,
        });

        Ok(())
    }

    pub fn instant_on_ramp(ctx: Context<InstantOnRamp>, amount: u64) -> Result<()> {
        require!(amount > 0, StablecoinRampError::InvalidAmount);
        assert_not_paused(&ctx.accounts.config)?;
        assert_whitelisted(&ctx.accounts.white_list, &ctx.accounts.user.key())?;
        let business_id_record = reserve_business_id_via_cpi(
            &ctx.accounts.business_id_factory_program,
            &ctx.accounts.factory_state,
            &ctx.accounts.authority,
            &ctx.accounts.business_id_record,
            &ctx.accounts.system_program,
            &ctx.accounts.token_config.symbol,
            BusinessIdRequestType::OnRamp,
        )?;
        assert_business_id_record(
            &ctx.accounts.factory_state,
            &ctx.accounts.token_config,
            &business_id_record,
            BusinessIdRequestType::OnRamp,
        )?;

        fill_request(
            &mut ctx.accounts.request,
            &ctx.accounts.user.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.user_token_account.key(),
            amount,
            RampRequestType::OnRamp,
            RampRequestStatus::RequestApproved,
            &business_id_record.ref_id,
        )?;
        ctx.accounts.request.updated_at = Clock::get()?.unix_timestamp;

        let signer_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            &[ctx.accounts.config.vault_authority_bump],
        ];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(RampProcessed {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount,
            request_type: RampRequestType::OnRamp,
            status: RampRequestStatus::RequestApproved,
        });

        Ok(())
    }

    pub fn request_off_ramp(ctx: Context<RequestOffRamp>, amount: u64) -> Result<()> {
        require!(amount > 0, StablecoinRampError::InvalidAmount);
        assert_not_paused(&ctx.accounts.config)?;
        assert_whitelisted(&ctx.accounts.white_list, &ctx.accounts.user.key())?;
        let business_id_record = reserve_business_id_via_cpi(
            &ctx.accounts.business_id_factory_program,
            &ctx.accounts.factory_state,
            &ctx.accounts.user,
            &ctx.accounts.business_id_record,
            &ctx.accounts.system_program,
            &ctx.accounts.token_config.symbol,
            BusinessIdRequestType::OffRamp,
        )?;
        assert_business_id_record(
            &ctx.accounts.factory_state,
            &ctx.accounts.token_config,
            &business_id_record,
            BusinessIdRequestType::OffRamp,
        )?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        fill_request(
            &mut ctx.accounts.request,
            &ctx.accounts.user.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.user_token_account.key(),
            amount,
            RampRequestType::OffRamp,
            RampRequestStatus::RequestInitiated,
            &business_id_record.ref_id,
        )?;

        emit!(RampRequested {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount,
            request_type: RampRequestType::OffRamp,
        });

        Ok(())
    }

    pub fn approve_off_ramp(ctx: Context<ProcessOffRamp>) -> Result<()> {
        assert_not_paused(&ctx.accounts.config)?;
        assert_request_pending(&ctx.accounts.request, RampRequestType::OffRamp)?;

        if ctx.accounts.token_config.is_self_issued {
            let signer_seeds: &[&[u8]] = &[
                VAULT_AUTHORITY_SEED,
                &[ctx.accounts.config.vault_authority_bump],
            ];
            burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                ctx.accounts.request.amount,
            )?;
        }

        mark_request_processed(&mut ctx.accounts.request, RampRequestStatus::RequestApproved)?;

        emit!(RampProcessed {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount: ctx.accounts.request.amount,
            request_type: RampRequestType::OffRamp,
            status: RampRequestStatus::RequestApproved,
        });

        Ok(())
    }

    pub fn reject_off_ramp(ctx: Context<RejectOffRamp>, reason: String) -> Result<()> {
        assert_request_pending(&ctx.accounts.request, RampRequestType::OffRamp)?;

        let signer_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            &[ctx.accounts.config.vault_authority_bump],
        ];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            ctx.accounts.request.amount,
            ctx.accounts.mint.decimals,
        )?;

        mark_request_processed(&mut ctx.accounts.request, RampRequestStatus::RequestRejected)?;

        emit!(RampRejected {
            business_id: ctx.accounts.request.business_id.clone(),
            requester: ctx.accounts.request.requester,
            mint: ctx.accounts.request.mint,
            amount: ctx.accounts.request.amount,
            request_type: RampRequestType::OffRamp,
            reason,
        });

        Ok(())
    }

    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64) -> Result<()> {
        require!(amount > 0, StablecoinRampError::InvalidAmount);
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TokenDeposited {
            mint: ctx.accounts.mint.key(),
            from: ctx.accounts.authority_token_account.key(),
            vault: ctx.accounts.vault.key(),
            amount,
        });

        Ok(())
    }

    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        require!(amount > 0, StablecoinRampError::InvalidAmount);
        let signer_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            &[ctx.accounts.config.vault_authority_bump],
        ];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TokenWithdrawn {
            mint: ctx.accounts.mint.key(),
            vault: ctx.accounts.vault.key(),
            to: ctx.accounts.destination_token_account.key(),
            amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [CONFIG_SEED],
        bump,
        space = 8 + StablecoinRampConfig::INIT_SPACE
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
}

#[derive(Accounts)]
#[instruction(symbol: String)]
pub struct RegisterToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        space = TokenConfig::space_for(&symbol)
    )]
    pub token_config: Account<'info, TokenConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestOnRamp<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(address = config.whitelist)]
    pub white_list: Account<'info, WhiteList>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        constraint = token_config.enabled @ StablecoinRampError::TokenNotEnabled
    )]
    pub token_config: Account<'info, TokenConfig>,
    #[account(
        address = config.business_id_factory @ StablecoinRampError::InvalidBusinessIdFactory
    )]
    pub business_id_factory_program: Program<'info, BusinessIdFactory>,
    #[account(
        mut,
        seeds = [b"business-id-factory"],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        mut,
        seeds = [BUSINESS_ID_RECORD_SEED],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    /// CHECK: Created by business-id-factory CPI in this instruction
    pub business_id_record: UncheckedAccount<'info>,
    #[account(
        init,
        payer = user,
        space = RampRequest::space_for_len(MAX_BUSINESS_ID_LEN)
    )]
    pub request: Account<'info, RampRequest>,
    #[account(
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessOnRamp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(address = config.whitelist)]
    pub white_list: Account<'info, WhiteList>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_config: Account<'info, TokenConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub request: Account<'info, RampRequest>,
    #[account(mut, address = request.user_token_account)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RejectRequest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(mut)]
    pub request: Account<'info, RampRequest>,
}

#[derive(Accounts)]
pub struct InstantOnRamp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(address = config.whitelist)]
    pub white_list: Box<Account<'info, WhiteList>>,
    /// CHECK: user wallet checked against whitelist
    pub user: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        constraint = token_config.enabled @ StablecoinRampError::TokenNotEnabled
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,
    #[account(
        address = config.business_id_factory @ StablecoinRampError::InvalidBusinessIdFactory
    )]
    pub business_id_factory_program: Program<'info, BusinessIdFactory>,
    #[account(
        mut,
        seeds = [b"business-id-factory"],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    pub factory_state: Box<Account<'info, FactoryState>>,
    #[account(
        mut,
        seeds = [BUSINESS_ID_RECORD_SEED],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    /// CHECK: Created by business-id-factory CPI in this instruction
    pub business_id_record: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = RampRequest::space_for_len(MAX_BUSINESS_ID_LEN)
    )]
    pub request: Box<Account<'info, RampRequest>>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = token_config.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestOffRamp<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(address = config.whitelist)]
    pub white_list: Account<'info, WhiteList>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        constraint = token_config.enabled @ StablecoinRampError::TokenNotEnabled
    )]
    pub token_config: Account<'info, TokenConfig>,
    #[account(
        address = config.business_id_factory @ StablecoinRampError::InvalidBusinessIdFactory
    )]
    pub business_id_factory_program: Program<'info, BusinessIdFactory>,
    #[account(
        mut,
        seeds = [b"business-id-factory"],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        mut,
        seeds = [BUSINESS_ID_RECORD_SEED],
        bump,
        seeds::program = business_id_factory_program.key()
    )]
    /// CHECK: Created by business-id-factory CPI in this instruction
    pub business_id_record: UncheckedAccount<'info>,
    #[account(
        init,
        payer = user,
        space = RampRequest::space_for_len(MAX_BUSINESS_ID_LEN)
    )]
    pub request: Account<'info, RampRequest>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessOffRamp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_config: Account<'info, TokenConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub request: Account<'info, RampRequest>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RejectOffRamp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub token_config: Account<'info, TokenConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub request: Account<'info, RampRequest>,
    #[account(mut, address = request.user_token_account)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        constraint = token_config.enabled @ StablecoinRampError::TokenNotEnabled
    )]
    pub token_config: Account<'info, TokenConfig>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = authority,
        token::token_program = token_program
    )]
    pub authority_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.authority == authority.key() @ StablecoinRampError::Unauthorized
    )]
    pub config: Account<'info, StablecoinRampConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED, mint.key().as_ref()],
        bump,
        constraint = token_config.enabled @ StablecoinRampError::TokenNotEnabled
    )]
    pub token_config: Account<'info, TokenConfig>,
    /// CHECK: PDA authority for token vaults
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = token_config.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
#[derive(InitSpace)]
pub struct StablecoinRampConfig {
    pub authority: Pubkey,
    pub business_id_factory: Pubkey,
    pub whitelist: Pubkey,
    pub paused: bool,
    pub vault_authority_bump: u8,
}

#[account]
pub struct TokenConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub symbol: String,
    pub enabled: bool,
    pub is_self_issued: bool,
}

impl TokenConfig {
    pub fn space_for(symbol: &str) -> usize {
        8 + 32 + 32 + 32 + 32 + 4 + symbol.len() + 1 + 1
    }
}

#[account]
pub struct RampRequest {
    pub requester: Pubkey,
    pub mint: Pubkey,
    pub user_token_account: Pubkey,
    pub amount: u64,
    pub request_type: RampRequestType,
    pub status: RampRequestStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub business_id: String,
}

impl RampRequest {
    pub fn space_for_len(business_id_len: usize) -> usize {
        8 + 32 + 32 + 32 + 8 + 1 + 1 + 8 + 8 + 4 + business_id_len
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RampRequestType {
    OnRamp,
    OffRamp,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RampRequestStatus {
    RequestInitiated,
    RequestApproved,
    RequestRejected,
}

#[event]
pub struct TokenRegistered {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub symbol: String,
    pub is_self_issued: bool,
}

#[event]
pub struct RampRequested {
    pub business_id: String,
    pub requester: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub request_type: RampRequestType,
}

#[event]
pub struct RampProcessed {
    pub business_id: String,
    pub requester: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub request_type: RampRequestType,
    pub status: RampRequestStatus,
}

#[event]
pub struct RampRejected {
    pub business_id: String,
    pub requester: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub request_type: RampRequestType,
    pub reason: String,
}

#[event]
pub struct TokenDeposited {
    pub mint: Pubkey,
    pub from: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokenWithdrawn {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum StablecoinRampError {
    #[msg("Only the authority can perform this action")]
    Unauthorized,
    #[msg("The program is paused")]
    ProgramPaused,
    #[msg("The account is not whitelisted")]
    AccountNotWhitelisted,
    #[msg("The token is not enabled")]
    TokenNotEnabled,
    #[msg("The provided business ID record belongs to a different factory")]
    InvalidBusinessIdFactory,
    #[msg("The business ID record does not match the token config or request type")]
    InvalidBusinessIdRecord,
    #[msg("The request is not in an initiated state")]
    InvalidRequestStatus,
    #[msg("The request type does not match")]
    InvalidRequestType,
    #[msg("The amount must be greater than zero")]
    InvalidAmount,
    #[msg("Token symbol must be 1-16 chars and only contain uppercase letters or digits")]
    InvalidSymbol,
}

fn validate_symbol(symbol: &str) -> Result<()> {
    let bytes = symbol.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_SYMBOL_LEN {
        return err!(StablecoinRampError::InvalidSymbol);
    }

    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return err!(StablecoinRampError::InvalidSymbol);
    }

    Ok(())
}

fn assert_not_paused(config: &Account<StablecoinRampConfig>) -> Result<()> {
    if config.paused {
        return err!(StablecoinRampError::ProgramPaused);
    }
    Ok(())
}

fn assert_whitelisted(white_list: &Account<WhiteList>, account: &Pubkey) -> Result<()> {
    if !white_list.contains(account) {
        return err!(StablecoinRampError::AccountNotWhitelisted);
    }
    Ok(())
}

fn assert_business_id_record(
    factory_state: &Account<FactoryState>,
    token_config: &Account<TokenConfig>,
    business_id_record: &BusinessIdRecord,
    request_type: BusinessIdRequestType,
) -> Result<()> {
    if business_id_record.factory != factory_state.key()
        || business_id_record.request_type != request_type
        || business_id_record.token_symbol != token_config.symbol
    {
        return err!(StablecoinRampError::InvalidBusinessIdRecord);
    }
    Ok(())
}

fn reserve_business_id_via_cpi<'info>(
    business_id_factory_program: &Program<'info, BusinessIdFactory>,
    factory_state: &Account<'info, FactoryState>,
    payer: &Signer<'info>,
    business_id_record: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    token_symbol: &str,
    request_type: BusinessIdRequestType,
) -> Result<BusinessIdRecord> {
    cpi::reserve_business_id(
        CpiContext::new(
            business_id_factory_program.to_account_info(),
            cpi::accounts::ReserveBusinessId {
                payer: payer.to_account_info(),
                factory_state: factory_state.to_account_info(),
                business_id_record: business_id_record.to_account_info(),
                system_program: system_program.to_account_info(),
            },
        ),
        token_symbol.to_string(),
        request_type,
    )?;

    let account_info = business_id_record.to_account_info();
    let data = account_info.try_borrow_data()?;
    BusinessIdRecord::try_deserialize(&mut &data[..])
}

fn fill_request(
    request: &mut Account<RampRequest>,
    requester: &Pubkey,
    mint: &Pubkey,
    user_token_account: &Pubkey,
    amount: u64,
    request_type: RampRequestType,
    status: RampRequestStatus,
    business_id: &str,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    request.requester = *requester;
    request.mint = *mint;
    request.user_token_account = *user_token_account;
    request.amount = amount;
    request.request_type = request_type;
    request.status = status;
    request.created_at = now;
    request.updated_at = now;
    request.business_id = business_id.to_string();
    Ok(())
}

fn assert_request_pending(
    request: &Account<RampRequest>,
    expected_type: RampRequestType,
) -> Result<()> {
    if request.request_type != expected_type {
        return err!(StablecoinRampError::InvalidRequestType);
    }
    if request.status != RampRequestStatus::RequestInitiated {
        return err!(StablecoinRampError::InvalidRequestStatus);
    }
    Ok(())
}

fn mark_request_processed(
    request: &mut Account<RampRequest>,
    status: RampRequestStatus,
) -> Result<()> {
    request.status = status;
    request.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
