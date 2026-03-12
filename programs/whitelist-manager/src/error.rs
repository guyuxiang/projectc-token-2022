use anchor_lang::prelude::*;

#[error_code]
pub enum WhiteListError {
    #[msg("Account not in white list")]
    AccountNotInWhiteList,
    #[msg("Unauthorized - only the authority can perform this action")]
    Unauthorized,
}
