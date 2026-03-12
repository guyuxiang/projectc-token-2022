use anchor_lang::prelude::*;

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

    pub fn remove(&mut self, account: &Pubkey) -> bool {
        if let Some(index) = self.white_list.iter().position(|entry| entry == account) {
            self.white_list.swap_remove(index);
            true
        } else {
            false
        }
    }
}
