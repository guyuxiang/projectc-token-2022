use anchor_lang::prelude::*;

declare_id!("3Qf7mADvu1G3cLRdQWm5wfSQP8tayogNL7yi4Rh5KbmZ");

const FACTORY_SEED: &[u8] = b"business-id-factory";
const RECORD_SEED: &[u8] = b"business-id-record";
const FACTORY_STATE_BYTES: usize = 8192;
const MAX_TOKEN_SYMBOL_LEN: usize = 16;
const MAX_REF_ID_LEN: usize = 64;

#[program]
pub mod business_id_factory {
    use super::*;

    pub fn initialize_factory(ctx: Context<InitializeFactory>) -> Result<()> {
        let factory = &mut ctx.accounts.factory_state;
        factory.authority = ctx.accounts.authority.key();
        if factory.counters.is_empty() {
            factory.counters = Vec::new();
        }
        Ok(())
    }

    pub fn update_authority(ctx: Context<UpdateAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.factory_state.authority = new_authority;
        Ok(())
    }

    pub fn reserve_business_id(
        ctx: Context<ReserveBusinessId>,
        token_symbol: String,
        request_type: RequestType,
    ) -> Result<()> {
        validate_token_symbol(&token_symbol)?;

        let timestamp = Clock::get()?.unix_timestamp;
        require!(timestamp >= 0, BusinessIdFactoryError::InvalidTimestamp);

        let (year, month, day, hour, minute, second) = unix_timestamp_to_utc(timestamp);
        let day_key = (year as u32) * 10_000 + month * 100 + day;
        let counter = next_sequence(
            &mut ctx.accounts.factory_state,
            day_key,
            &token_symbol,
            request_type,
        );
        let ref_id = build_ref_id(
            year,
            month,
            day,
            hour,
            minute,
            second,
            &token_symbol,
            request_type,
            counter,
        );

        let record = &mut ctx.accounts.business_id_record;
        record.factory = ctx.accounts.factory_state.key();
        record.creator = ctx.accounts.payer.key();
        record.token_symbol = token_symbol;
        record.request_type = request_type;
        record.sequence = counter;
        record.day_key = day_key;
        record.timestamp = timestamp;
        record.ref_id = ref_id.clone();

        emit!(BusinessIdReserved {
            creator: record.creator,
            factory: record.factory,
            request_type,
            token_symbol: record.token_symbol.clone(),
            sequence: counter,
            ref_id,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeFactory<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [FACTORY_SEED],
        bump,
        space = 8 + FACTORY_STATE_BYTES
    )]
    pub factory_state: Account<'info, FactoryState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FACTORY_SEED],
        bump,
        constraint = factory_state.authority == authority.key() @ BusinessIdFactoryError::Unauthorized
    )]
    pub factory_state: Account<'info, FactoryState>,
}

#[derive(Accounts)]
#[instruction(token_symbol: String, request_type: RequestType)]
pub struct ReserveBusinessId<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [FACTORY_SEED],
        bump
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [RECORD_SEED],
        bump,
        space = BusinessIdRecord::space_for_len(MAX_REF_ID_LEN),
    )]
    pub business_id_record: Account<'info, BusinessIdRecord>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct FactoryState {
    pub authority: Pubkey,
    pub counters: Vec<CounterEntry>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CounterEntry {
    pub day_key: u32,
    pub request_type: RequestType,
    pub token_symbol: String,
    pub sequence: u64,
}

#[account]
pub struct BusinessIdRecord {
    pub factory: Pubkey,
    pub creator: Pubkey,
    pub token_symbol: String,
    pub request_type: RequestType,
    pub sequence: u64,
    pub day_key: u32,
    pub timestamp: i64,
    pub ref_id: String,
}

impl BusinessIdRecord {
    pub fn space_for_len(ref_id_len: usize) -> usize {
        8 + 32 + 32 + 4 + MAX_TOKEN_SYMBOL_LEN + 1 + 8 + 4 + 8 + 4 + ref_id_len
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RequestType {
    OnRamp,
    OffRamp,
}

#[event]
pub struct BusinessIdReserved {
    pub creator: Pubkey,
    pub factory: Pubkey,
    pub request_type: RequestType,
    pub token_symbol: String,
    pub sequence: u64,
    pub ref_id: String,
}

#[error_code]
pub enum BusinessIdFactoryError {
    #[msg("Only the factory authority can perform this action")]
    Unauthorized,
    #[msg("Token symbol must be 1-16 chars and only contain uppercase letters or digits")]
    InvalidTokenSymbol,
    #[msg("Clock timestamp must be non-negative")]
    InvalidTimestamp,
}

fn validate_token_symbol(symbol: &str) -> Result<()> {
    let bytes = symbol.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_TOKEN_SYMBOL_LEN {
        return err!(BusinessIdFactoryError::InvalidTokenSymbol);
    }

    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return err!(BusinessIdFactoryError::InvalidTokenSymbol);
    }

    Ok(())
}

fn next_sequence(
    factory_state: &mut Account<FactoryState>,
    day_key: u32,
    token_symbol: &str,
    request_type: RequestType,
) -> u64 {
    if let Some(entry) = factory_state.counters.iter_mut().find(|entry| {
        entry.day_key == day_key
            && entry.request_type == request_type
            && entry.token_symbol == token_symbol
    }) {
        entry.sequence = entry.sequence.saturating_add(1);
        entry.sequence
    } else {
        factory_state.counters.push(CounterEntry {
            day_key,
            request_type,
            token_symbol: token_symbol.to_string(),
            sequence: 1,
        });
        1
    }
}

fn build_ref_id(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    token_symbol: &str,
    request_type: RequestType,
    sequence: u64,
) -> String {
    let mut ref_id = format!(
        "{year:04}{month:02}{day:02}{hour:02}{minute:02}{second:02}{token_symbol}{}",
        request_type_tag(request_type)
    );
    ref_id.push_str(&format_sequence(sequence));
    ref_id
}

fn request_type_tag(request_type: RequestType) -> &'static str {
    match request_type {
        RequestType::OnRamp => "ONRAMP",
        RequestType::OffRamp => "OFFRAMP",
    }
}

fn format_sequence(sequence: u64) -> String {
    if sequence < 1_000_000 {
        format!("{sequence:06}")
    } else {
        sequence.to_string()
    }
}

fn unix_timestamp_to_utc(timestamp: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = timestamp.div_euclid(86_400);
    let seconds = timestamp.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}
