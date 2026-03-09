use std::cell::RefMut;

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            transfer_hook::TransferHookAccount, BaseStateWithExtensionsMut,
            PodStateWithExtensionsMut,
        },
        pod::PodAccount,
    },
    token_interface::{Mint, TokenAccount},
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("B6zKa3LBfyfRCMZmPbHyvxZ4F7W674XJ9ptnoVrojprK");

#[error_code]
pub enum TransferError {
    #[msg("The token is not currently transferring")]
    IsNotCurrentlyTransferring,
    #[msg("The new whitelist size overflows")]
    WhiteListSizeOverflow,
    #[msg("Account not in white list")]
    AccountNotInWhiteList,
    #[msg("Account already in white list")]
    AccountAlreadyInWhiteList,
    #[msg("Unauthorized - only the authority can perform this action")]
    Unauthorized,
}

#[program]
pub mod transfer_hook {
    use super::*;

    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        // 判断 white_list 是否已存在（authority 不为零）
        let is_existing = ctx.accounts.white_list.authority != Pubkey::default();

        // 如果已存在，检查权限
        if is_existing && ctx.accounts.white_list.authority != ctx.accounts.payer.key() {
            return err!(TransferError::Unauthorized);
        }

        // set authority field on white_list account as payer address
        ctx.accounts.white_list.authority = ctx.accounts.payer.key();

        let extra_account_metas = InitializeExtraAccountMetaList::extra_account_metas()?;

        // initialize ExtraAccountMetaList account with extra accounts
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;
        Ok(())
    }

    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Fail this instruction if it is not called from within a transfer hook
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

        msg!("Account in white list, all good!");

        Ok(())
    }

    pub fn add_to_whitelist(ctx: Context<AddToWhiteList>) -> Result<()> {
        if ctx.accounts.white_list.authority != ctx.accounts.signer.key() {
            return err!(TransferError::Unauthorized);
        }

        if ctx
            .accounts
            .white_list
            .contains(&ctx.accounts.new_account.key())
        {
            msg!(
                "Account already white listed! {0}",
                ctx.accounts.new_account.key().to_string()
            );
            return Ok(());
        }

        ctx.accounts
            .white_list
            .white_list
            .push(ctx.accounts.new_account.key());
        msg!(
            "New account white listed! {0}",
            ctx.accounts.new_account.key().to_string()
        );
        msg!(
            "White list length! {0}",
            ctx.accounts.white_list.white_list.len()
        );

        Ok(())
    }

    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhiteList>) -> Result<()> {
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
            "Account removed from white list! {0}",
            ctx.accounts.account_to_remove.key().to_string()
        );
        msg!(
            "White list length! {0}",
            ctx.accounts.white_list.white_list.len()
        );

        Ok(())
    }
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

// WhiteList 结构
//   - discriminator: 8
//   - authority: Pubkey: 32
//   - Vec<Pubkey> 长度前缀: 4
//   - 1 个白名单地址: 32
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList Account, must use these seeds
    #[account(
        init,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
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
        seeds = [b"white_list"],
        bump,
        payer = payer,
        space = 1000
    )]
    pub white_list: Account<'info, WhiteList>,
}

// Define extra account metas to store on extra_account_meta_list account
impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
        Ok(vec![ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: "white_list".as_bytes().to_vec(),
            }],
            false, // is_signer
            true,  // is_writable
        )?])
    }
}

// Order of accounts matters for this struct.
// The first 4 accounts are the accounts required for token transfer (source, mint, destination, owner)
// Remaining accounts are the extra accounts required from the ExtraAccountMetaList account
// These accounts are provided via CPI to this program from the token2022 program
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint, token::authority = owner)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account owner, can be SystemAccount or PDA owned by another program
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList Account,
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [b"white_list"], bump)]
    pub white_list: Account<'info, WhiteList>,
}

#[derive(Accounts)]
pub struct AddToWhiteList<'info> {
    /// CHECK: New account to add to white list
    #[account()]
    pub new_account: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"white_list"],
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
        seeds = [b"white_list"],
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

#[account]
pub struct WhiteList {
    pub authority: Pubkey,
    pub white_list: Vec<Pubkey>,
}

impl WhiteList {
    pub const DISCRIMINATOR_LEN: usize = 8;
    pub const PUBKEY_LEN: usize = 32;
    pub const VEC_PREFIX_LEN: usize = 4;

    pub fn space_for_len(entry_count: usize) -> usize {
        Self::DISCRIMINATOR_LEN
            + Self::PUBKEY_LEN
            + Self::VEC_PREFIX_LEN
            + entry_count * Self::PUBKEY_LEN
    }

    pub fn contains(&self, account: &Pubkey) -> bool {
        self.white_list.contains(account)
    }

    pub fn space_after_add(&self, account: Pubkey) -> usize {
        if self.contains(&account) {
            Self::space_for_len(self.white_list.len())
        } else {
            Self::space_for_len(self.white_list.len().saturating_add(1))
        }
    }

    pub fn space_after_remove(&self, account: Pubkey) -> usize {
        if self.contains(&account) {
            Self::space_for_len(self.white_list.len().saturating_sub(1))
        } else {
            Self::space_for_len(self.white_list.len())
        }
    }

    pub fn remove(&mut self, account: &Pubkey) -> bool {
        if let Some(index) = self.white_list.iter().position(|entry| entry == account) {
            self.white_list.swap_remove(index);
            true
        } else {
            false
        }
    }
}
