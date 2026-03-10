use anchor_lang::prelude::*;

use crate::{constants::EVENT_WHITELIST_REMOVED, error::TransferError, RemoveFromWhiteList};

pub fn handler(ctx: Context<RemoveFromWhiteList>) -> Result<()> {
    if ctx.accounts.white_list.authority != ctx.accounts.signer.key() {
        return err!(TransferError::Unauthorized);
    }

    let removed = ctx
        .accounts
        .white_list
        .remove(&ctx.accounts.account_to_remove.key());

    if !removed {
        return err!(TransferError::AccountNotInWhiteList);
    }

    msg!(
        "{} account={} authority={}",
        EVENT_WHITELIST_REMOVED,
        ctx.accounts.account_to_remove.key(),
        ctx.accounts.signer.key()
    );

    Ok(())
}
