use receiver_core::{
    pipeline::presets,
    session::{Config, Input, Overview, Session},
    wave::{IqWave, PcmWave},
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};
fn temporary(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("jr-receiver-test-{}-{name}", std::process::id()))
}
fn silence(path: &PathBuf, samples: u32) {
    let mut f = fs::File::create(path).unwrap();
    let size = samples * 8;
    f.write_all(b"RIFF").unwrap();
    f.write_all(&(36 + size).to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    for b in [
        16u32.to_le_bytes(),
        [3, 0, 2, 0],
        240000u32.to_le_bytes(),
        1920000u32.to_le_bytes(),
        [8, 0, 32, 0],
    ] {
        f.write_all(&b).unwrap();
    }
    f.write_all(b"data").unwrap();
    f.write_all(&size.to_le_bytes()).unwrap();
    f.write_all(&vec![0; size as usize]).unwrap();
}

fn wait_for_session_end(session: &Session) -> Overview {
    let start = Instant::now();
    loop {
        let (status, _) = session.snapshot(None);
        if !status.running {
            return status;
        }
        // This bounds a stalled test, not DSP throughput. All 22 unoptimized
        // workers must drain, even on a busy CI runner.
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "session did not finish within 20 seconds: {}",
            serde_json::to_string(&status).unwrap()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn all_22_workers_receive_the_same_iq_and_finish_without_drops() {
    let path = temporary("all.wav");
    silence(&path, 38400);
    let mut session = Session::start(Config {
        input: Input::Wave {
            path: path.to_string_lossy().into(),
            center_hz: 352603125.0,
        },
        channels: presets("east"),
    })
    .unwrap();
    let final_status = wait_for_session_end(&session);
    assert_eq!(final_status.state, "completed", "{:?}", final_status.error);
    assert_eq!(final_status.channels.len(), 22);
    for c in final_status.channels {
        assert_eq!(c.status.iq_samples, 38400, "{}", c.config.id);
        assert_eq!(c.dropped_blocks, 0);
        assert_eq!(c.status.discontinuities, 0);
        assert_eq!(c.status.frames, 0);
        assert!(c.error.is_none());
    }
    session.stop();
    fs::remove_file(path).unwrap();
}
#[test]
fn cancellation_joins_workers_and_new_session_has_no_old_state() {
    let path = temporary("stop.wav");
    silence(&path, 240000);
    for _ in 0..2 {
        let mut session = Session::start(Config {
            input: Input::Wave {
                path: path.to_string_lossy().into(),
                center_hz: 352603125.0,
            },
            channels: presets("west"),
        })
        .unwrap();
        session.stop();
        let (s, a) = session.snapshot(None);
        assert!(!s.running);
        assert_eq!(s.state, "stopped");
        assert!(a.is_empty());
    }
    fs::remove_file(path).unwrap();
}
#[test]
fn invalid_bandwidth_fails_the_session_before_any_channel_runs() {
    let path = temporary("outside.wav");
    silence(&path, 1000);
    let mut session = Session::start(Config {
        input: Input::Wave {
            path: path.to_string_lossy().into(),
            center_hz: 300000000.0,
        },
        channels: presets("east"),
    })
    .unwrap();
    let start = Instant::now();
    loop {
        let (s, _) = session.snapshot(None);
        if !s.running {
            assert_eq!(s.state, "failed");
            assert!(s.error.unwrap().contains("outside"));
            assert!(s.channels.iter().all(|c| c.status.iq_samples == 0));
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    session.stop();
    fs::remove_file(path).unwrap();
}
#[test]
fn malformed_wave_and_oversized_pcm_gap_are_rejected_without_overwriting() {
    let path = temporary("bad.wav");
    silence(&path, 10);
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(0);
    fs::write(&path, bytes).unwrap();
    assert!(IqWave::open(&path).is_err());
    fs::remove_file(&path).unwrap();
    let mut pcm = PcmWave::create(&path).unwrap();
    assert!(PcmWave::create(&path).is_err());
    assert!(pcm.silence(u32::MAX as u64 * 320).is_err());
    pcm.write(&[1, -2, 3]).unwrap();
    pcm.finish().unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 50);
    assert_eq!(&bytes[40..44], &6u32.to_le_bytes());
    fs::remove_file(path).unwrap();
}

#[test]
fn rtl_tcp_disconnect_is_a_failure_after_all_22_workers_drain() {
    use std::{io::Read, net::TcpListener};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.write_all(b"RTL0\0\0\0\x05\0\0\0\x1d").unwrap();
        // Rate, frequency, ppm, manual gain mode, top gain index.
        stream.read_exact(&mut [0; 25]).unwrap();
        stream.write_all(&vec![127; 38400 * 2]).unwrap();
    });
    let mut session = Session::start(Config {
        input: Input::RtlTcp {
            radio: receiver_core::rtl_tcp::Config {
                host: "127.0.0.1".into(),
                port,
                sample_rate: 240000,
                center_hz: 352603125,
                gain_db: None,
                ppm: 0,
            },
        },
        channels: presets("east"),
    })
    .unwrap();
    let status = wait_for_session_end(&session);
    assert_eq!(status.state, "failed", "{:?}", status.error);
    assert!(status.error.as_deref().unwrap().contains("接続を閉じ"));
    assert_eq!(status.channels.len(), 22);
    for channel in status.channels {
        assert_eq!(channel.status.iq_samples, 38400, "{}", channel.config.id);
        assert_eq!(channel.dropped_blocks, 0, "{}", channel.config.id);
        assert_eq!(channel.status.discontinuities, 0, "{}", channel.config.id);
        assert!(channel.error.is_none(), "{:?}", channel.error);
    }
    session.stop();
    server.join().unwrap();
}

#[test]
fn stopping_during_rtl_tcp_handshake_closes_connection_without_failure() {
    use std::{io::Read, net::TcpListener, sync::mpsc};
    let timeout = Duration::from_secs(20);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (connected, wait) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(timeout)).unwrap();
        connected.send(()).unwrap();
        // Keep the handshake pending until the client closes the connection.
        // A server timeout or unexpected command must fail this test.
        match stream.read(&mut [0]) {
            Ok(0) => {}
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
            result => panic!("expected the client to close its connection, got {result:?}"),
        }
    });
    let mut session = Session::start(Config {
        input: Input::RtlTcp {
            radio: receiver_core::rtl_tcp::Config {
                host: "127.0.0.1".into(),
                port,
                sample_rate: 240000,
                center_hz: 352603125,
                gain_db: None,
                ppm: 0,
            },
        },
        channels: presets("east"),
    })
    .unwrap();
    wait.recv_timeout(timeout)
        .expect("test server did not accept the RTL-TCP connection");
    let (stopped, wait) = mpsc::channel();
    let client = std::thread::spawn(move || {
        session.stop();
        stopped.send(session.snapshot(None)).unwrap();
    });
    // Bound a stuck stop, without treating CI scheduling time as a latency
    // guarantee. The RTL-TCP unit test checks the cancellation error itself.
    let (s, audio) = wait
        .recv_timeout(timeout)
        .expect("stopping during the RTL-TCP handshake did not finish");
    client.join().unwrap();
    server.join().unwrap();
    assert!(!s.running);
    assert_eq!(s.state, "stopped");
    assert!(s.error.is_none());
    assert!(audio.is_empty());
    assert_eq!(s.channels.len(), 22);
    assert!(s
        .channels
        .iter()
        .all(|c| c.status.iq_samples == 0 && c.error.is_none()));
}

#[test]
#[ignore = "requires JR_TEST_IQ_WAV and JR_TEST_IQ_CENTER; run optimized with a short valid IQ WAV"]
fn recorded_iq_runs_all_22_workers_in_real_time() {
    let path = std::env::var("JR_TEST_IQ_WAV").expect("set JR_TEST_IQ_WAV");
    let center = std::env::var("JR_TEST_IQ_CENTER")
        .expect("set JR_TEST_IQ_CENTER")
        .parse()
        .unwrap();
    let wave = IqWave::open(&path).unwrap();
    let samples = wave.samples;
    let duration = samples as f64 / wave.sample_rate;
    let mut session = Session::start(Config {
        input: Input::Wave {
            path,
            center_hz: center,
        },
        channels: presets("east"),
    })
    .unwrap();
    let start = Instant::now();
    let output = temporary("iq-jsonl-output");
    fs::create_dir(&output).unwrap();
    while session.snapshot(None).0.state == "starting" {
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
    let recording = session
        .start_recording_with_options(
            &output,
            receiver_core::recording::OutputOptions {
                audio: true,
                raw_frames: true,
                data_messages: true,
            },
        )
        .unwrap();
    let final_status = loop {
        let (s, _) = session.snapshot(None);
        if !s.running {
            break s;
        }
        assert!(start.elapsed().as_secs_f64() < duration + 20.0);
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(final_status.state, "completed", "{:?}", final_status.error);
    assert!(final_status.channels.iter().any(|c| c.status.frames > 0));
    for c in &final_status.channels {
        assert_eq!(c.status.iq_samples, samples, "{}", c.config.id);
        assert_eq!(c.dropped_blocks, 0, "{}", c.config.id);
        assert_eq!(c.status.discontinuities, 0);
    }
    assert_eq!(final_status.recording.state, "completed");
    assert!(final_status.recording.raw_frames > 0);
    let dir = PathBuf::from(recording.directory.unwrap());
    let raw: Vec<serde_json::Value> = fs::read_to_string(dir.join("raw-frames.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let data: Vec<serde_json::Value> = fs::read_to_string(dir.join("data-messages.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(raw.len() as u64, final_status.recording.raw_frames);
    assert_eq!(data.len() as u64, final_status.recording.data_messages);
    assert!(!dir.join("INCOMPLETE").exists());
    for row in &raw {
        assert_eq!(row["raw_hex"].as_str().unwrap().len(), 96);
        assert!(final_status
            .channels
            .iter()
            .any(|c| c.config.id == row["channel_id"]));
    }
    println!("{}", serde_json::to_string(&final_status).unwrap());
    fs::remove_dir_all(output).unwrap();
    session.stop();
}
