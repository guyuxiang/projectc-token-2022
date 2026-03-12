use anchor_lang::prelude::*;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::{error::TransferError, InitializeExtraAccountMetaList};

pub fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    if ctx.accounts.white_list.authority != ctx.accounts.payer.key() {
        return err!(TransferError::Unauthorized);
    }

    let extra_account_metas =
        InitializeExtraAccountMetaList::extra_account_metas(&ctx.accounts.white_list.key())?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
        &extra_account_metas,
    )?;

    Ok(())
}
