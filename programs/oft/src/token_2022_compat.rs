use anchor_lang::solana_program::pubkey::Pubkey;
use anchor_spl::token::spl_token;
use spl_token_2022::extension::StateWithExtensions;
use std::ops::Deref;

static IDS: [Pubkey; 2] = [spl_token::ID, spl_token_2022::ID];

#[derive(Clone, Debug, Default, PartialEq, Copy)]
pub struct Token2022AccountCompat(spl_token_2022::state::Account);

impl anchor_lang::AccountDeserialize for Token2022AccountCompat {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        StateWithExtensions::<spl_token_2022::state::Account>::unpack(buf)
            .map(|account| Token2022AccountCompat(account.base))
            .map_err(Into::into)
    }
}

impl anchor_lang::AccountSerialize for Token2022AccountCompat {}

impl anchor_lang::Owners for Token2022AccountCompat {
    fn owners() -> &'static [Pubkey] {
        &IDS
    }
}

impl Deref for Token2022AccountCompat {
    type Target = spl_token_2022::state::Account;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[derive(Clone, Debug, Default, PartialEq, Copy)]
pub struct Token2022MintCompat(spl_token_2022::state::Mint);

impl anchor_lang::AccountDeserialize for Token2022MintCompat {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        StateWithExtensions::<spl_token_2022::state::Mint>::unpack(buf)
            .map(|mint| Token2022MintCompat(mint.base))
            .map_err(Into::into)
    }
}

impl anchor_lang::AccountSerialize for Token2022MintCompat {}

impl anchor_lang::Owners for Token2022MintCompat {
    fn owners() -> &'static [Pubkey] {
        &IDS
    }
}

impl Deref for Token2022MintCompat {
    type Target = spl_token_2022::state::Mint;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
