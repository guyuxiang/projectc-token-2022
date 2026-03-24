use crate::*;

#[derive(Accounts)]
pub struct WithdrawFee<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [OFT_SEED, oft_store.token_mint.as_ref()],
        bump = oft_store.bump,
        has_one = admin @OFTError::Unauthorized
    )]
    pub oft_store: Account<'info, OFTStore>,
}

impl WithdrawFee<'_> {
    pub fn apply(_ctx: &mut Context<WithdrawFee>, params: &WithdrawFeeParams) -> Result<()> {
        require!(params.fee_ld == 0, OFTError::InvalidFee);
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawFeeParams {
    pub fee_ld: u64,
}
