use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use constants::{EXTRA_ACCOUNT_METAS_SEED, WHITE_LIST_SEED};
use state::WhiteList;

declare_id!("5LMLujHtNx4VARPXPAUveyRVoMbhmQyM36sasbieoJLw");

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList account derived from mint
    #[account(
        init,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(
            InitializeExtraAccountMetaList::extra_account_metas()?.len()
        )?,
        payer = payer
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    #[account(
        init_if_needed,
        seeds = [WHITE_LIST_SEED],
        bump,
        payer = payer,
        space = 1000
    )]
    pub white_list: Account<'info, WhiteList>,
}

impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
        Ok(vec![ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: WHITE_LIST_SEED.to_vec(),
            }],
            false,
            true,
        )?])
    }
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Source token authority or delegate, validated by Token-2022 before hook CPI
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList account derived from mint
    #[account(seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [WHITE_LIST_SEED], bump)]
    pub white_list: Account<'info, WhiteList>,
}

#[derive(Accounts)]
pub struct AddToWhiteList<'info> {
    /// CHECK: New account to add to white list
    #[account()]
    pub new_account: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [WHITE_LIST_SEED],
        bump,
        realloc = white_list
            .to_account_info()
            .data_len()
            .max(white_list.space_after_add(new_account.key())),
        realloc::payer = signer,
        realloc::zero = false
    )]
    pub white_list: Account<'info, WhiteList>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhiteList<'info> {
    /// CHECK: Account to remove from white list
    #[account()]
    pub account_to_remove: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [WHITE_LIST_SEED],
        bump,
        realloc = white_list.to_account_info().data_len(),
        realloc::payer = signer,
        realloc::zero = false
    )]
    pub white_list: Account<'info, WhiteList>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[program]
pub mod transfer_hook {
    use super::*;

    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        crate::instructions::initialize_extra_account_meta_list::handler(ctx)
    }

    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        crate::instructions::transfer_hook::handler(ctx, amount)
    }

    pub fn add_to_whitelist(ctx: Context<AddToWhiteList>) -> Result<()> {
        crate::instructions::add_to_whitelist::handler(ctx)
    }

    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhiteList>) -> Result<()> {
        crate::instructions::remove_from_whitelist::handler(ctx)
    }
}
