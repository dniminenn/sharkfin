// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
/// gen2 speed is a frame divider that starts at 0; yc500 starts at 1.
#[test]
fn speed_range_follows_the_family() {
    use super::*;
    let p = LedParam {
        mode: 4,
        speed: 4,
        brightness: 7,
        option: 0,
        dazzle: false,
        r: 1,
        g: 2,
        b: 3,
    };
    assert_eq!(p.to_packet_for(LedWire::GEN2)[2], 0);
    assert_eq!(p.to_packet_for(LedWire::YC500)[2], 1);
    assert_eq!(
        p.to_packet_for(LedWire::GEN2)[3],
        4,
        "brightness clamps to the table"
    );
    let wide = LedWire {
        brightness_max: 7,
        ..LedWire::YC500
    };
    assert_eq!(p.to_packet_for(wide)[3], 7);
    let mut reply = [0u8; 64];
    reply[0] = cmd::GET_LEDPARAM;
    reply[1] = 4;
    reply[2] = 0;
    reply[3] = 6;
    reply[4] = 7;
    let g = LedParam::from_reply_for(&reply, LedWire::GEN2).unwrap();
    assert_eq!((g.speed, g.brightness), (4, 4));
    let w = LedParam::from_reply_for(&reply, wide).unwrap();
    assert_eq!((w.speed, w.brightness), (4, 6));
}

#[test]
fn swapped_lineage_trades_the_two_flag_values() {
    use super::*;
    let fixed = LedParam {
        mode: 1,
        speed: 2,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 0x90,
        g: 0x13,
        b: 0xFE,
    };
    assert_eq!(fixed.to_packet()[4] & 0x0F, 7);
    assert_eq!(fixed.to_packet_on(true)[4] & 0x0F, 8);
    let rainbow = LedParam {
        dazzle: true,
        ..fixed
    };
    assert_eq!(rainbow.to_packet_on(true)[4] & 0x0F, 7);
    // The ACR75 v2's own GET reply while showing a solid colour.
    let reply = [0x87, 1, 4, 3, 0x08, 0x90, 0x13, 0xFE];
    assert!(
        LedParam::from_reply(&reply).unwrap().dazzle,
        "read as the X86 lineage it is rainbow"
    );
    let p = LedParam::from_reply_on(&reply, true).unwrap();
    assert!(!p.dazzle, "read as its own lineage it is fixed");
    assert_eq!((p.r, p.g, p.b), (0x90, 0x13, 0xFE));
    let preset = [0x87, 1, 4, 3, 0x01, 0, 0, 0];
    assert_eq!(
        LedParam::from_reply_on(&preset, true).unwrap().g,
        0xFF,
        "preset 1 is green there"
    );
    assert_eq!(
        LedParam::from_reply(&preset).unwrap().g,
        0x80,
        "and orange on the X86"
    );
}

/// The edge light follows the same board's backlight: in the 606 image
/// both renderers test the two values by exact compare, the same way
/// round.
#[test]
fn the_edge_light_follows_the_same_lineage() {
    use super::*;
    let rainbow = SledParam {
        mode: 1,
        speed: 2,
        brightness: 4,
        option: 0,
        dazzle: true,
        r: 0xFF,
        g: 0x00,
        b: 0x00,
    };
    assert_eq!(rainbow.to_packet()[4] & 0x0F, 8);
    assert_eq!(rainbow.to_packet_on(true)[4] & 0x0F, 7);
    let fixed = SledParam {
        dazzle: false,
        ..rainbow
    };
    assert_eq!(fixed.to_packet()[4] & 0x0F, 7);
    assert_eq!(fixed.to_packet_on(true)[4] & 0x0F, 8);
    // Neon brings its own colours whichever way round the board is.
    let neon = SledParam {
        mode: MODE_NEON,
        dazzle: false,
        ..rainbow
    };
    assert_eq!(neon.to_packet()[4] & 0x0F, 8);
    assert_eq!(neon.to_packet_on(true)[4] & 0x0F, 7);
    let reply = [0x88, 1, 2, 4, 0x08, 0x90, 0x13, 0xFE];
    assert!(SledParam::from_reply(&reply).unwrap().dazzle);
    assert!(!SledParam::from_reply_on(&reply, true).unwrap().dazzle);
    let preset = [0x88, 1, 2, 4, 0x01, 0, 0, 0];
    assert_eq!(SledParam::from_reply_on(&preset, true).unwrap().g, 0xFF);
    assert_eq!(SledParam::from_reply(&preset).unwrap().g, 0x80);
}

use super::*;

#[test]
fn checksum_bit7() {
    let mut buf = [0u8; REPORT_LEN];
    buf[0] = 0x8F;
    apply_checksum(&mut buf, Checksum::Bit7);
    assert_eq!(buf[7], 0xFF - 0x8F);
}

#[test]
fn checksum_bit8() {
    let mut buf = [0u8; REPORT_LEN];
    buf[0] = 0x07;
    buf[1] = 0x01;
    apply_checksum(&mut buf, Checksum::Bit8);
    assert_eq!(buf[8], 0xFF - 0x08);
}

#[test]
fn device_id() {
    let mut reply = [0u8; 64];
    reply[0] = 0x8F;
    reply[1..5].copy_from_slice(&1967u32.to_le_bytes());
    assert_eq!(parse_device_id(&reply), Some(1967));
}

#[test]
fn led_speed_inverts_on_wire() {
    let p = LedParam {
        mode: 2,
        speed: 3,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 1,
        g: 2,
        b: 3,
    };
    assert_eq!(p.to_packet()[2], 2);
}

#[test]
fn led_white_sentinel_round_trips() {
    let p = LedParam {
        mode: 1,
        speed: 3,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 0xFF,
        g: 0xFF,
        b: 0xFF,
    };
    let pkt = p.to_packet();
    assert_eq!(&pkt[5..8], &[0xFA, 0xFA, 0xFA]);
    let mut reply = [0u8; 64];
    reply[0] = cmd::GET_LEDPARAM;
    reply[1..8].copy_from_slice(&pkt[1..8]);
    let back = LedParam::from_reply(&reply).unwrap();
    assert_eq!((back.r, back.g, back.b), (0xFF, 0xFF, 0xFF));
    assert_eq!(back.speed, 3);
}

#[test]
fn sleep_write_and_read_offsets_differ() {
    let s = SleepTimes {
        sleep_bt: 180,
        sleep_24: 180,
        deep_bt: 3420,
        deep_24: 3420,
    };
    let pkt = s.to_packet();
    assert_eq!(&pkt[8..10], &180u16.to_le_bytes());
    assert_eq!(&pkt[14..16], &3420u16.to_le_bytes());

    // reads come back four bytes earlier
    let mut reply = [0u8; 64];
    reply[0] = cmd::GET_SLEEPTIME;
    reply[1..3].copy_from_slice(&180u16.to_le_bytes());
    reply[3..5].copy_from_slice(&180u16.to_le_bytes());
    reply[5..7].copy_from_slice(&3420u16.to_le_bytes());
    reply[7..9].copy_from_slice(&3420u16.to_le_bytes());
    let back = SleepTimes::from_reply(&reply).unwrap();
    assert_eq!(back.sleep_bt, 180);
    assert_eq!(back.deep_24, 3420);
}

#[test]
fn kb_options_never_write_system_bit() {
    let o = KbOptions {
        win_lock: true,
        wasd_swap: true,
        led_off: false,
        side_led_off: false,
        mac_mode: true,
    };
    let pkt = o.to_packet(0xFF, 0, 0);
    assert_eq!(pkt[2] & 0b0000_0110, 0, "system bits must stay clear");
    assert_eq!(pkt[2] & 1, 1);
    assert_eq!(pkt[2] & 8, 8);
    assert_eq!(pkt[2] & 0b1100_0000, 0b1100_0000, "high bits preserved");
}

#[test]
fn macro_blob_round_trips() {
    let m = Macro {
        repeat: 3,
        events: vec![
            MacroEvent::Key {
                usage: 0x0B,
                pressed: true,
                delay_ms: 20,
            },
            MacroEvent::Key {
                usage: 0x0B,
                pressed: false,
                delay_ms: 500,
            },
            MacroEvent::MouseButton {
                button: 1,
                pressed: true,
                delay_ms: 0,
            },
            MacroEvent::MouseButton {
                button: 1,
                pressed: false,
                delay_ms: 127,
            },
            MacroEvent::MouseMove {
                dx: -5,
                dy: 120,
                delay_ms: 8,
            },
        ],
    };
    let blob = m.to_blob().unwrap();
    assert_eq!(&blob[..2], &3u16.to_le_bytes());
    assert_eq!(Macro::from_blob(&blob), m);
}

#[test]
fn macro_delay_form_boundaries() {
    // 127 ms fits the short form; 128 and 0 must take the long form,
    // because a low nibble of zero doubles as the long-form marker.
    let ev = |d| MacroEvent::Key {
        usage: 4,
        pressed: true,
        delay_ms: d,
    };
    let short = Macro {
        repeat: 1,
        events: vec![ev(127)],
    }
    .to_blob()
    .unwrap();
    assert_eq!(&short[2..4], &[4, 0x80 | 127]);
    assert_eq!(short[4], 0, "short form is 2 bytes");

    for d in [0u16, 128] {
        let long = Macro {
            repeat: 1,
            events: vec![ev(d)],
        }
        .to_blob()
        .unwrap();
        assert_eq!(
            &long[2..6],
            &[4, 0x80, d.to_le_bytes()[0], d.to_le_bytes()[1]]
        );
        let back = Macro::from_blob(&long);
        assert_eq!(back.events, vec![ev(d)]);
    }
}

#[test]
fn macro_write_packet_header() {
    let mut blob = [0u8; MACRO_BYTES];
    blob[..2].copy_from_slice(&1u16.to_le_bytes());
    blob[100] = 0xAA; // page 1
    assert_eq!(macro_pages(&blob), 2);

    let pkt = macro_write_packet(cmd::SET_MACRO, 7, 1, true, &blob);
    assert_eq!(&pkt[..7], &[cmd::SET_MACRO, 7, 1, 56, 1, 0, 0]);
    let sum: u32 = pkt[..7].iter().map(|&b| b as u32).sum();
    assert_eq!(pkt[7], 0xFF - (sum & 0xFF) as u8);
    assert_eq!(pkt[8 + (100 - 56)], 0xAA);

    // final page carries only the 32-byte tail of the blob
    let tail = macro_write_packet(cmd::SET_MACRO, 7, 4, true, &blob);
    assert_eq!(tail[3], 56);
    assert_eq!(&tail[8 + 32..], &[0u8; 24]);
}

#[test]
fn macro_pages_minimum_one() {
    let blob = [0u8; MACRO_BYTES];
    assert_eq!(macro_pages(&blob), 1);
}

#[test]
fn macro_overflow_and_range_errors() {
    let too_long = Macro {
        repeat: 1,
        events: vec![
            MacroEvent::Key {
                usage: 4,
                pressed: true,
                delay_ms: 1000, // 4-byte form × 70 = 280 > 250
            };
            70
        ],
    };
    assert!(too_long.to_blob().is_err());
    let bad_usage = Macro {
        repeat: 1,
        events: vec![MacroEvent::Key {
            usage: 0xF0,
            pressed: true,
            delay_ms: 1,
        }],
    };
    assert!(bad_usage.to_blob().is_err());
}

#[test]
fn family_tables_model_the_documented_collisions() {
    // the dangerous overlaps from docs/PROTOCOL.md, verbatim
    assert_eq!(GEN2_CMDS.set_kboption, YC500_CMDS.set_keymatrix);
    assert_eq!(GEN2_CMDS.set_debounce, YC500_CMDS.set_kboption);
    assert_eq!(GEN2_CMDS.set_sleeptime, YC500_CMDS.set_debounce);
    assert_eq!(GEN2_CMDS.set_macro, cmd::SET_MACRO_PAGED);
    // gen2 has no single-slot write; keymaps must go through bulk pages
    assert!(GEN2_CMDS.set_key_one.is_none());
    assert!(GEN2_CMDS.set_fn_one.is_none());
    assert!(family_cmds("unknown").is_none());
}

#[test]
fn gen2_keymap_packets_match_the_vendor_shapes() {
    // single slot: byte 2 is the slot, byte 4 the apply flag
    let pkt = gen2::set_key_packet(1, 42, [0, 0, 74, 0]);
    assert_eq!(&pkt[..7], &[0x0A, 1, 42, 0, 0, 1, 0]);
    assert_eq!(&pkt[8..12], &[0, 0, 74, 0]);

    // fn slot: leads with host-OS byte (win = 0)
    let fnp = gen2::set_fn_key_packet(1, 42, [0, 0, 74, 0]);
    assert_eq!(&fnp[..4], &[0x10, 0, 1, 42]);

    // bulk: 0xFF sentinel in byte 2, 10 pages, last flag on the final one
    let matrix = [0xABu8; 512];
    let pages = gen2::bulk_keymatrix_packets(0, &matrix);
    assert_eq!(pages.len(), 10);
    assert_eq!(&pages[0][..6], &[0x0A, 0, 0xFF, 0, 56, 0]);
    // final page holds the 512 - 9*56 = 8 remaining bytes
    assert_eq!(&pages[9][..6], &[0x0A, 0, 0xFF, 9, 8, 1]);
    assert_eq!(&pages[9][8..16], &[0xAB; 8]);
    assert_eq!(pages[9][16], 0, "tail padded with zeros");

    // yc500 bulk: 0xF8 marker, page at byte 4, 9 pages of 56
    let y = yc500_bulk_layer_packets(2, &matrix, false);
    assert_eq!(y.len(), 9);
    assert_eq!(&y[0][..5], &[0x09, 2, 0xF8, 1, 0]);
    assert_eq!(&y[8][..5], &[0x09, 2, 0xF8, 1, 8]);
    // 9 * 56 = 504 < 512: the last 8 matrix bytes do not fit. 594_v310
    // stores page * 56 and commits on page 8, so the firmware truncates
    // the same way.
    assert_eq!(&y[8][8..8 + 56], &[0xAB; 56]);
    let f = yc500_bulk_layer_packets(2, &matrix, true);
    assert_eq!(&f[0][..5], &[0x10, 2, 0xF8, 1, 0]);
}

#[test]
fn gen2_userpic_packets_match_the_firmware_parse() {
    // 2268_v309, handler 0x8010db8: sentinel at byte 2, page at 3,
    // length at 4, last flag at 5. Seven pages, 42 bytes on the last,
    // and the 384-byte UI blob loses its final two keys on the wire.
    let blob = [0xCDu8; PER_KEY_BYTES];
    let pages = gen2::userpic_packets(0, &blob);
    assert_eq!(pages.len(), 7);
    assert_eq!(&pages[0][..6], &[0x0C, 0, 0xFF, 0, 56, 0]);
    assert_eq!(&pages[6][..6], &[0x0C, 0, 0xFF, 6, 42, 1]);
    assert_eq!(&pages[6][8..8 + 42], &[0xCD; 42]);
    assert_eq!(pages[6][8 + 42], 0, "tail padded with zeros");
}

#[test]
/// Offsets below are read off the X65HE firmware (2268_v309) -- the gen2
/// family's own code. See docs/PROTOCOL.md.
fn sleep_reply_parses_under_either_familys_opcode() {
    assert_eq!(GEN2_CMDS.debounce_at, 1, "gen2 value sits at wire byte 1");
    assert_eq!(YC500_CMDS.debounce_at, 2, "yc500 pads with a zero byte");
    assert_eq!(YC500_CMDS.sleep_reply_at, 1);
    assert_eq!(GEN2_CMDS.sleep_reply_at, 8, "gen2 reply is symmetric");
    assert!(
        GEN2_CMDS.kboption.is_none(),
        "gen2 option semantics unestablished; withheld rather than guessed"
    );
    assert!(YC500_CMDS.kboption.is_some());

    let mut reply = [0u8; 64];
    reply[0] = GEN2_CMDS.get_sleeptime;
    reply[8..10].copy_from_slice(&300u16.to_le_bytes());
    let s = SleepTimes::from_reply_expecting(&reply, GEN2_CMDS.get_sleeptime, 8).unwrap();
    assert_eq!(s.sleep_bt, 300);
    assert!(
        SleepTimes::from_reply(&reply).is_none(),
        "yc500 offsets must not parse a gen2 reply"
    );
}

#[test]
fn near_black_floors_instead_of_lights_out() {
    let p = LedParam {
        mode: 1,
        speed: 3,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 0,
        g: 0,
        b: 0,
    };
    assert_eq!(&p.to_packet()[5..8], &[COLOR_FLOOR; 3]);
    // dark but visible colours pass through untouched
    let navy = LedParam { b: 20, ..p };
    assert_eq!(&navy.to_packet()[5..8], &[0, 0, 20]);
    let sled = SledParam {
        mode: 1,
        speed: 2,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 2,
        g: 2,
        b: 2,
    };
    assert_eq!(&sled.to_packet()[5..8], &[COLOR_FLOOR; 3]);
}

#[test]
fn led_preset_color_index() {
    let mut reply = [0u8; 64];
    reply[0] = cmd::GET_LEDPARAM;
    reply[1] = 1;
    reply[2] = 2;
    reply[3] = 1;
    reply[4] = 4; // preset index 4 = cyan
    reply[5..8].copy_from_slice(&[0xB4, 0xB4, 0xB4]);
    let p = LedParam::from_reply(&reply).unwrap();
    assert_eq!((p.r, p.g, p.b), (0x00, 0xFF, 0xFF));
    assert!(!p.dazzle);
}

/// Screen Colour always goes out with a zero nibble, which is also
/// preset index 0. Reading it back must keep the board's own colour.
#[test]
fn led_screen_color_keeps_its_rgb() {
    let mut reply = [0u8; 64];
    reply[0] = cmd::GET_LEDPARAM;
    reply[1] = MODE_SCREEN_COLOR;
    reply[2] = 2;
    reply[3] = 1;
    reply[4] = 0;
    reply[5..8].copy_from_slice(&[0x10, 0x20, 0xF0]);
    let p = LedParam::from_reply(&reply).unwrap();
    assert_eq!((p.r, p.g, p.b), (0x10, 0x20, 0xF0));
    assert!(!p.dazzle);
    let again = LedParam::from_reply(&p.to_packet()).map(|q| (q.r, q.g, q.b));
    assert_eq!(again, None, "a packet is not a reply");
}

// The firmware reads the announce back byte for byte (0x23F1E in the
// RT100 image), so these offsets are the contract, not a preference.
#[test]
fn the_announce_puts_each_field_where_the_firmware_looks() {
    let pkt = screen_announce_packet(0xA5, 2, 5, 30, 0xABCD, (1, 2, 0x140, 0x88), 3);
    assert_eq!(pkt[0], 0xA5);
    assert_eq!(pkt[1], 2, "frame index");
    assert_eq!(pkt[2], 5, "frame count");
    assert_eq!(pkt[3], 30, "frame delay");
    assert_eq!([pkt[4], pkt[5]], [0xCD, 0xAB], "length, low half, LE");
    assert_eq!(
        [pkt[8], pkt[9], pkt[10], pkt[11]],
        [1, 2, 0x40, 0x88],
        "bbox low"
    );
    assert_eq!(
        [pkt[12], pkt[13], pkt[14], pkt[15]],
        [0, 0, 1, 0],
        "bbox high"
    );
    assert_eq!([pkt[16], pkt[17]], [0, 0], "length, high half");
    assert_eq!(pkt[18], 3, "layer");
    // Byte 7 is the checksum and must survive the wide fields.
    let sum: u32 = pkt[..7].iter().map(|&b| b as u32).sum();
    assert_eq!(pkt[7], 0xFF - (sum & 0xFF) as u8);
}

#[test]
fn pages_carry_their_index_and_their_own_length() {
    let data: Vec<u8> = (0..(SCREEN_PAGE_DATA * 2 + 5) as u16)
        .map(|i| i as u8)
        .collect();
    let pages = screen_page_packets(0x25, 0, 1, 0, &data);
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[0][6], SCREEN_PAGE_DATA as u8);
    assert_eq!(pages[2][6], 5, "a short last page states its real length");
    assert_eq!([pages[1][4], pages[1][5]], [1, 0], "page index, LE");
    assert_eq!(
        &pages[0][8..8 + SCREEN_PAGE_DATA],
        &data[..SCREEN_PAGE_DATA]
    );
    assert_eq!(&pages[2][8..13], &data[SCREEN_PAGE_DATA * 2..]);
    // The tail of a short page stays zero rather than repeating data.
    assert!(pages[2][13..].iter().all(|&b| b == 0));
}

#[test]
fn pixels_go_out_column_major_in_big_endian_565() {
    // 2x2: red, green / blue, white.
    let rgb = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let out = screen_pixels(&rgb, 2, 2, "16").unwrap();
    assert_eq!(out.len(), 8);
    // Column 0 is red then blue, not red then green.
    assert_eq!(&out[0..2], &[0xF8, 0x00], "red");
    assert_eq!(&out[2..4], &[0x00, 0x1F], "blue, below it");
    assert_eq!(&out[4..6], &[0x07, 0xE0], "green, second column");
    assert_eq!(&out[6..8], &[0xFF, 0xFF], "white");
}

#[test]
fn twenty_four_bit_pixels_are_plain_triples_in_the_same_column_order() {
    // 2x2: red, green / blue, white.
    let rgb = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let out = screen_pixels(&rgb, 2, 2, "24").unwrap();
    // Column 0 is red then blue, not red then green.
    assert_eq!(out, vec![255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255]);
}

#[test]
fn a_frame_that_does_not_fit_the_display_is_refused() {
    assert!(screen_pixels(&[0; 12], 4, 4, "16").is_err());
}

// The vendor's builder writes the fields past the checksum byte, so the
// checksum is that of a bare opcode whatever the time.
#[test]
fn the_clock_sits_past_the_checksum() {
    let pkt = clock_packet(2001, 2, 3, 4, 5, 6);
    assert_eq!(pkt[0], cmd::SET_OLED_CLOCK);
    assert_eq!(
        pkt[7],
        0xFF - cmd::SET_OLED_CLOCK,
        "checksum of the opcode alone"
    );
    assert_eq!(&pkt[8..15], &[0x07, 0xD1, 2, 3, 4, 5, 6]);
    assert!(pkt[15..].iter().all(|&b| b == 0));
}
