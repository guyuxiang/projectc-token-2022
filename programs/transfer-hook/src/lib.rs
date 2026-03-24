use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use whitelist_manager::state::WhiteList;

pub mod constants;
pub mod error;
pub mod instructions;

use constants::EXTRA_ACCOUNT_METAS_SEED;

declare_id!("6EW124q8HaQb4DCkFoP1WZ5HC8Mt8HfSzvxV66oN2ezF");

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList account derived from mint
    #[account(
        init,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(1)?,
        payer = payer
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        constraint = white_list.authority == payer.key() @ error::TransferError::Unauthorized
    )]
    pub white_list: Account<'info, WhiteList>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas(white_list: &Pubkey) -> Result<Vec<ExtraAccountMeta>> {
        Ok(vec![ExtraAccountMeta::new_with_pubkey(
            white_list,
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
    pub white_list: Account<'info, WhiteList>,
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
}
