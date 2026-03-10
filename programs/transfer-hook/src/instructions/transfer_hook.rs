use std::cell::RefMut;

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensionsMut, PodStateWithExtensionsMut,
    },
    pod::PodAccount,
};

use crate::{error::TransferError, TransferHook};

pub fn handler(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
    check_is_transferring(&ctx)?;

    if !ctx
        .accounts
        .white_list
        .white_list
        .contains(&ctx.accounts.source_token.key())
    {
        return err!(TransferError::AccountNotInWhiteList);
    }

    if !ctx
        .accounts
        .white_list
        .white_list
        .contains(&ctx.accounts.destination_token.key())
    {
        return err!(TransferError::AccountNotInWhiteList);
    }

    Ok(())
}

fn check_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    let source_token_info = ctx.accounts.source_token.to_account_info();
    let mut account_data_ref: RefMut<&mut [u8]> = source_token_info.try_borrow_mut_data()?;
    let mut account = PodStateWithExtensionsMut::<PodAccount>::unpack(*account_data_ref)?;
    let account_extension = account.get_extension_mut::<TransferHookAccount>()?;

    if !bool::from(account_extension.transferring) {
        return err!(TransferError::IsNotCurrentlyTransferring);
    }

    Ok(())
}
