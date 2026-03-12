use anchor_lang::prelude::*;

use crate::{constants::EVENT_WHITELIST_ADDED, error::WhiteListError, AddToWhiteList};

pub fn handler(ctx: Context<AddToWhiteList>) -> Result<()> {
    if ctx.accounts.white_list.authority != ctx.accounts.authority.key() {
        return err!(WhiteListError::Unauthorized);
    }

    if ctx
        .accounts
        .white_list
        .contains(&ctx.accounts.new_account.key())
    {
        return Ok(());
    }

    ctx.accounts
        .white_list
        .white_list
        .push(ctx.accounts.new_account.key());

    msg!(
        "{} account={} authority={}",
        EVENT_WHITELIST_ADDED,
        ctx.accounts.new_account.key(),
        ctx.accounts.authority.key()
    );

    Ok(())
}
