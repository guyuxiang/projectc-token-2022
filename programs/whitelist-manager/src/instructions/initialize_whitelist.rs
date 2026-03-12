use anchor_lang::prelude::*;

use crate::InitializeWhiteList;

pub fn handler(ctx: Context<InitializeWhiteList>) -> Result<()> {
    ctx.accounts.white_list.authority = ctx.accounts.authority.key();
    Ok(())
}
