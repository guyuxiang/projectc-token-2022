use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use constants::WHITE_LIST_SEED;
use state::WhiteList;

declare_id!("DtYLNr7A4wYkjDJqMo4Vq29v8pC8gtsspoyBdZFkUqyT");

#[derive(Accounts)]
pub struct InitializeWhiteList<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = WhiteList::space_for_len(0),
        seeds = [WHITE_LIST_SEED, authority.key().as_ref()],
        bump
    )]
    pub white_list: Account<'info, WhiteList>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToWhiteList<'info> {
    /// CHECK: New account to add to white list
    pub new_account: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [WHITE_LIST_SEED, authority.key().as_ref()],
        bump,
        realloc = white_list
            .to_account_info()
            .data_len()
            .max(white_list.space_after_add(new_account.key())),
        realloc::payer = authority,
        realloc::zero = false
    )]
    pub white_list: Account<'info, WhiteList>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhiteList<'info> {
    /// CHECK: Account to remove from white list
    pub account_to_remove: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [WHITE_LIST_SEED, authority.key().as_ref()],
        bump
    )]
    pub white_list: Account<'info, WhiteList>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[program]
pub mod whitelist_manager {
    use super::*;

    pub fn initialize_whitelist(ctx: Context<InitializeWhiteList>) -> Result<()> {
        crate::instructions::initialize_whitelist::handler(ctx)
    }

    pub fn add_to_whitelist(ctx: Context<AddToWhiteList>) -> Result<()> {
        crate::instructions::add_to_whitelist::handler(ctx)
    }

    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhiteList>) -> Result<()> {
        crate::instructions::remove_from_whitelist::handler(ctx)
    }
}
