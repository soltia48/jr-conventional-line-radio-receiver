//! Native rtl_tcp input. Control words are big-endian; samples are interleaved CU8.
//! The protocol has no command acknowledgements or sample-loss counters.
use crate::{source::Read, Complex32};
use serde::{Deserialize, Serialize};
use std::{
    io::{ErrorKind, Read as _, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub sample_rate: u32,
    pub center_hz: u32,
    pub gain_db: Option<f64>,
    #[serde(default)]
    pub ppm: i32,
}
impl Config {
    pub fn validate(&self) -> Result<SocketAddr, String> {
        let ip: IpAddr = self
            .host
            .parse()
            .map_err(|_| "RTL-TCP: IPv4 / IPv6 アドレスを入力してください")?;
        if self.port == 0 || self.center_hz == 0 {
            return Err("RTL-TCP: ポートと中心周波数は 0 より大きい値を指定してください".into());
        }
        // librtlsdr rejects the gap between these two ranges.
        if !(225001..=300000).contains(&self.sample_rate)
            && !(900001..=3200000).contains(&self.sample_rate)
        {
            return Err("RTL-TCP: サンプルレートは 225001–300000 または 900001–3200000 S/s を指定してください".into());
        }
        if self
            .gain_db
            .is_some_and(|g| !g.is_finite() || !(-10.0..=100.0).contains(&g))
            || !(-1000..=1000).contains(&self.ppm)
        {
            return Err(
                "RTL-TCP: ゲインは −10–100 dB、周波数補正は −1000–1000 ppm を指定してください"
                    .into(),
            );
        }
        Ok(SocketAddr::new(ip, self.port))
    }
}

// rtl_tcp's automatic mode hands gain to the tuner's AGC, which drives the
// 8-bit ADC into clipping on this wideband multi-carrier input (measured: 6.6 %
// of samples clipped, worse than the highest manual gain) and loses frame sync.
// An empty gain therefore selects manual gain stepped down from the top of the
// tuner's table while the ADC clips. It never steps up again: alternating
// between clipping and not would cost frames on every step.
// Light clipping must last this many 50 ms windows before the gain steps.
const LIGHT_CLIPPING_WINDOWS: u32 = 10;
struct AutoGain {
    index: u32,
    // Samples still to discard: a new gain reaches the stream only after the
    // server's USB buffer (256 KiB) and the network drain.
    holdoff: u64,
    settle: u64,
    window: u64,
    seen: u64,
    clipped: u64,
    // Consecutive windows with light clipping; a brief burst does not step.
    strikes: u32,
}
impl AutoGain {
    fn new(gain_count: u32, sample_rate: u32) -> Option<Self> {
        let index = gain_count.checked_sub(1)?;
        let settle = 131072 + u64::from(sample_rate) / 5;
        Some(Self {
            index,
            holdoff: settle,
            settle,
            window: (u64::from(sample_rate) / 20).max(1),
            seen: 0,
            clipped: 0,
            strikes: 0,
        })
    }
    /// Counts clipped components in `bytes` (interleaved CU8) and returns the
    /// next gain index once a full window clipped too often.
    fn observe(&mut self, bytes: &[u8]) -> Option<u32> {
        let mut samples = (bytes.len() / 2) as u64;
        let mut start = 0;
        if self.holdoff > 0 {
            let skip = self.holdoff.min(samples);
            self.holdoff -= skip;
            samples -= skip;
            start = skip as usize * 2;
        }
        if samples == 0 || self.index == 0 {
            return None;
        }
        self.seen += samples;
        self.clipped += bytes[start..]
            .iter()
            .filter(|&&b| b == 0 || b == 255)
            .count() as u64;
        if self.seen < self.window {
            return None;
        }
        // Clipped I/Q components per 1000 samples.
        let rate = self.clipped * 1000 / self.seen;
        self.seen = 0;
        self.clipped = 0;
        let step = match rate {
            0 => {
                self.strikes = 0;
                return None;
            }
            1..=9 => {
                self.strikes += 1;
                if self.strikes < LIGHT_CLIPPING_WINDOWS {
                    return None;
                }
                1
            }
            10..=39 => 2,
            _ => 3,
        };
        self.strikes = 0;
        self.index = self.index.saturating_sub(step);
        self.holdoff = self.settle;
        Some(self.index)
    }
}

pub struct RtlTcp {
    stream: TcpStream,
    bytes: Vec<u8>,
    filled: usize,
    last_data: Instant,
    auto_gain: Option<AutoGain>,
    pub tuner_type: u32,
    pub gain_count: u32,
}
impl RtlTcp {
    pub fn open(config: &Config, stop: &AtomicBool) -> Result<Self, String> {
        let address = config.validate()?;
        let mut stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|e| {
                format!(
                    "RTL-TCP: {address} に接続できません。サーバーとポートを確認してください ({e})"
                )
            })?;
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut header = [0; 12];
        let mut filled = 0;
        let deadline = Instant::now() + Duration::from_secs(3);
        while filled < header.len() {
            if stop.load(Ordering::Relaxed) {
                return Err("RTL-TCP: 接続を中止しました".into());
            }
            if Instant::now() >= deadline {
                return Err(
                    "RTL-TCP: ヘッダーが届きません。他のクライアントが接続中か確認してください"
                        .into(),
                );
            }
            match stream.read(&mut header[filled..]) {
                Ok(0) => return Err("RTL-TCP: ヘッダー受信中に接続が閉じられました".into()),
                Ok(n) => filled += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(format!("RTL-TCP: ヘッダーを受信できません ({e})")),
            }
        }
        if &header[..4] != b"RTL0" {
            return Err(
                "RTL-TCP: RTL0 ヘッダーではありません。rtl_tcp のポートを指定してください".into(),
            );
        }
        let mut input = Self {
            stream,
            bytes: Vec::new(),
            filled: 0,
            last_data: Instant::now(),
            auto_gain: None,
            tuner_type: u32::from_be_bytes(header[4..8].try_into().unwrap()),
            gain_count: u32::from_be_bytes(header[8..12].try_into().unwrap()),
        };
        input.command(0x02, config.sample_rate)?;
        input.command(0x01, config.center_hz)?;
        input.command(0x05, config.ppm as u32)?;
        match config.gain_db {
            Some(gain) => {
                input.command(0x03, 1)?;
                input.command(0x04, (gain * 10.0).round() as i32 as u32)?;
            }
            None => match AutoGain::new(input.gain_count, config.sample_rate) {
                Some(auto) => {
                    input.command(0x03, 1)?;
                    input.command(0x0d, auto.index)?;
                    input.auto_gain = Some(auto);
                }
                // No gain table reported: only the tuner's AGC is available.
                None => input.command(0x03, 0)?,
            },
        }
        Ok(input)
    }
    fn command(&mut self, command: u8, value: u32) -> Result<(), String> {
        let mut word = [command, 0, 0, 0, 0];
        word[1..].copy_from_slice(&value.to_be_bytes());
        self.stream
            .write_all(&word)
            .map_err(|e| format!("RTL-TCP: 設定を送信できません ({e})"))
    }
    pub fn read(&mut self, output: &mut [Complex32]) -> Result<Read, String> {
        if output.is_empty() {
            return Err("RTL-TCP: IQ buffer is empty".into());
        }
        let size = output.len() * 2;
        // Keep partial samples across TCP packet boundaries and timeouts.
        if self.filled > size {
            return Err("RTL-TCP: IQ buffer shrank during a partial read".into());
        }
        self.bytes.resize(size, 0);
        let started = Instant::now();
        while self.filled < size {
            if started.elapsed() >= Duration::from_millis(100) {
                return Ok(Read::Timeout);
            }
            match self.stream.read(&mut self.bytes[self.filled..]) {
                Ok(0) => {
                    return Err(
                        "RTL-TCP: サーバーが接続を閉じました。受信を再開してください".into(),
                    )
                }
                Ok(n) => {
                    self.filled += n;
                    self.last_data = Instant::now();
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) =>
                {
                    if self.last_data.elapsed() >= Duration::from_secs(5) {
                        return Err("RTL-TCP: IQ データが 5 秒間届きません。サーバーと回線を確認してください".into());
                    }
                    return Ok(Read::Timeout);
                }
                Err(e) => return Err(format!("RTL-TCP: IQ 受信エラー ({e})")),
            }
        }
        if let Some(index) = self
            .auto_gain
            .as_mut()
            .and_then(|g| g.observe(&self.bytes[..size]))
        {
            self.command(0x0d, index)?;
        }
        for (out, pair) in output.iter_mut().zip(self.bytes.as_chunks::<2>().0) {
            *out = Complex32 {
                real: (pair[0] as f32 - 127.5) / 128.0,
                imaginary: (pair[1] as f32 - 127.5) / 128.0,
            };
        }
        self.filled = 0;
        Ok(Read::Samples(output.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        sync::{mpsc, Arc},
        thread,
    };
    fn config(port: u16) -> Config {
        Config {
            host: "127.0.0.1".into(),
            port,
            sample_rate: 240000,
            center_hz: 352603125,
            gain_db: Some(19.7),
            ppm: -12,
        }
    }
    fn header(s: &mut TcpStream) {
        s.write_all(b"RTL0\0\0\0\x05\0\0\0\x1d").unwrap();
    }
    #[test]
    fn fragmented_iq_survives_timeouts_and_commands_use_network_byte_order() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (resume, wait) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            header(&mut s);
            let mut commands = [0; 25];
            s.read_exact(&mut commands).unwrap();
            for (word, (op, value)) in commands.as_chunks::<5>().0.iter().zip([
                (2, 240000u32),
                (1, 352603125),
                (5, (-12i32) as u32),
                (3, 1),
                (4, 197),
            ]) {
                assert_eq!(word[0], op);
                assert_eq!(u32::from_be_bytes(word[1..].try_into().unwrap()), value);
            }
            s.write_all(&[0, 255, 128]).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            s.write_all(&[127]).unwrap();
        });
        let mut input = RtlTcp::open(&config(port), &AtomicBool::new(false)).unwrap();
        assert_eq!((input.tuner_type, input.gain_count), (5, 29));
        let mut iq = [Complex32::default(); 2];
        assert!(matches!(input.read(&mut iq).unwrap(), Read::Timeout));
        resume.send(()).unwrap();
        assert!(matches!(input.read(&mut iq).unwrap(), Read::Samples(2)));
        assert_eq!(
            (iq[0].real, iq[0].imaginary),
            (-127.5 / 128.0, 127.5 / 128.0)
        );
        assert_eq!((iq[1].real, iq[1].imaginary), (0.5 / 128.0, -0.5 / 128.0));
        server.join().unwrap();
        assert!(input.read(&mut iq).unwrap_err().contains("接続を閉じ"));
    }
    #[test]
    fn empty_gain_steps_manual_gain_down_while_the_adc_clips() {
        // 240 kS/s: 50 ms windows of 12000 samples after a 179072-sample settle.
        let mut gain = AutoGain::new(29, 240000).unwrap();
        assert_eq!(gain.index, 28);
        let clean = vec![128u8; 24000];
        let mut heavy = clean.clone();
        heavy[..1000].fill(255);
        // Samples still in flight from the previous gain are ignored.
        let in_flight = vec![255u8; gain.settle as usize * 2];
        assert_eq!(gain.observe(&in_flight), None);
        assert_eq!(gain.holdoff, 0);
        assert_eq!(gain.observe(&heavy), Some(25));
        assert_eq!(gain.holdoff, gain.settle);
        // Light clipping (1 per mille) steps once only after persisting.
        gain.holdoff = 0;
        let mut light = clean.clone();
        light[..12].fill(0);
        for _ in 0..LIGHT_CLIPPING_WINDOWS - 1 {
            assert_eq!(gain.observe(&light), None);
        }
        assert_eq!(gain.observe(&light), Some(24));
        gain.holdoff = 0;
        for _ in 0..LIGHT_CLIPPING_WINDOWS - 1 {
            assert_eq!(gain.observe(&light), None);
        }
        assert_eq!(gain.observe(&clean), None);
        assert_eq!(gain.observe(&light), None);
        // A clean signal never raises the gain; the lowest index stays put.
        for _ in 0..100 {
            assert_eq!(gain.observe(&clean), None);
        }
        gain.index = 1;
        assert_eq!(gain.observe(&heavy), Some(0));
        gain.holdoff = 0;
        assert_eq!(gain.observe(&heavy), None);
        assert!(AutoGain::new(0, 240000).is_none());
    }
    #[test]
    fn empty_gain_selects_the_top_manual_gain_index() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            header(&mut s);
            let mut commands = [0; 25];
            s.read_exact(&mut commands).unwrap();
            let words: Vec<_> = commands
                .as_chunks::<5>()
                .0
                .iter()
                .map(|w| (w[0], u32::from_be_bytes(w[1..].try_into().unwrap())))
                .collect();
            assert_eq!(&words[3..], [(3, 1), (0x0d, 28)]);
        });
        let mut c = config(port);
        c.gain_db = None;
        let input = RtlTcp::open(&c, &AtomicBool::new(false)).unwrap();
        assert_eq!(input.auto_gain.as_ref().map(|g| g.index), Some(28));
        server.join().unwrap();
    }
    #[test]
    fn silent_server_fails_instead_of_receiving_forever() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, wait) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            header(&mut s);
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        let mut input = RtlTcp::open(&config(port), &AtomicBool::new(false)).unwrap();
        input.last_data = Instant::now() - Duration::from_secs(6);
        let error = input.read(&mut [Complex32::default(); 10]).err().unwrap();
        assert!(error.contains("5 秒間"));
        release.send(()).unwrap();
        server.join().unwrap();
    }
    #[test]
    fn header_wait_can_be_cancelled_and_wrong_protocol_is_rejected() {
        let timeout = Duration::from_secs(20);
        for cancel in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let stop = Arc::new(AtomicBool::new(false));
            let signal = stop.clone();
            let server = thread::spawn(move || {
                let (mut s, _) = listener.accept().unwrap();
                s.set_read_timeout(Some(timeout)).unwrap();
                if cancel {
                    signal.store(true, Ordering::Relaxed);
                } else {
                    s.write_all(b"HTTP/1.1 200 ").unwrap();
                }
                let mut byte = [0];
                // Rejecting a protocol may close with unread bytes, causing
                // a reset instead of an orderly EOF. Both mean it closed.
                match s.read(&mut byte) {
                    Ok(0) => {}
                    Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
                    result => panic!("expected the client to close its connection, got {result:?}"),
                }
            });
            let (opened, wait) = mpsc::channel();
            let client = thread::spawn(move || {
                let error = RtlTcp::open(&config(port), &stop).err().unwrap();
                opened.send(error).unwrap();
            });
            let error = wait
                .recv_timeout(timeout)
                .expect("RTL-TCP header wait did not finish");
            // Ignoring cancellation would return the missing-header error,
            // which must still fail even on a slow or heavily loaded runner.
            assert!(error.contains(if cancel { "中止" } else { "RTL0" }));
            client.join().unwrap();
            server.join().unwrap();
        }
    }
    #[test]
    fn unsupported_rates_and_invalid_addresses_are_rejected_before_connecting() {
        let mut c = config(1234);
        for rate in [0, 9600, 225000, 300001, 900000, 3200001] {
            c.sample_rate = rate;
            assert!(c.validate().is_err());
        }
        for rate in [225001, 240000, 300000, 900001, 3200000] {
            c.sample_rate = rate;
            assert!(c.validate().is_ok());
        }
        c.host = "bad host".into();
        assert!(c.validate().is_err());
        c.host = "::1".into();
        assert!(c.validate().is_ok());
        c.port = 0;
        assert!(c.validate().is_err());
    }
}
