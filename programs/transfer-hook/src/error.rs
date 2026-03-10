use anchor_lang::prelude::*;

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
