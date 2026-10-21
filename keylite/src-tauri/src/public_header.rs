use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

const HEADER_MAX_BYTES: usize = 1_048_576;
const MAX_PATH_UNITS: usize = 32_767;
const MAX_FIELDS: usize = 256;
const HEADER_INVALID: &str = "HEADER_INVALID";
const HEADER_TOO_LARGE: &str = "HEADER_TOO_LARGE";
const HEADER_UNSUPPORTED: &str = "HEADER_UNSUPPORTED";
const HEADER_IO: &str = "HEADER_IO";
const HEADER_FORBIDDEN: &str = "HEADER_FORBIDDEN";
const KDBX_SIG1: [u8; 4] = 0x9AA2D903u32.to_le_bytes();
const KDBX_SIG2: [u8; 4] = 0xB54BFB67u32.to_le_bytes();
const END_OF_HEADER: [u8; 4] = [0x0d, 0x0a, 0x0d, 0x0a];
// Existing vendored kdbxweb releases serialize this historical marker.
// Accept it for existing KeyTree files without changing their serialization.
const VENDORED_END_OF_HEADER: [u8; 4] = [0x00, 0xd0, 0xad, 0x0a];

fn read_exact_header<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<(), &'static str> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            HEADER_INVALID
        } else {
            HEADER_IO
        }
    })
}

fn file_too_short(original_len: Option<u64>, required: usize) -> bool {
    original_len.is_some_and(|length| length < required as u64)
}

fn parse_public_header<R: Read>(
    reader: &mut R,
    original_len: Option<u64>,
) -> Result<Vec<u8>, &'static str> {
    if file_too_short(original_len, 12) {
        return Err(HEADER_INVALID);
    }

    let mut fixed = [0u8; 12];
    read_exact_header(reader, &mut fixed)?;
    if fixed[..4] != KDBX_SIG1 || fixed[4..8] != KDBX_SIG2 {
        return Err(HEADER_INVALID);
    }

    let minor = u16::from_le_bytes([fixed[8], fixed[9]]);
    let major = u16::from_le_bytes([fixed[10], fixed[11]]);
    if major == 3 {
        return Err(HEADER_UNSUPPORTED);
    }
    if major != 4 || minor > 1 {
        return Err(HEADER_UNSUPPORTED);
    }

    let mut header = fixed.to_vec();
    let mut seen = [false; 256];
    let mut field_count = 0usize;

    loop {
        field_count += 1;
        if field_count > MAX_FIELDS {
            return Err(HEADER_INVALID);
        }

        let field_header_end = header.len().checked_add(5).ok_or(HEADER_TOO_LARGE)?;
        if field_header_end > HEADER_MAX_BYTES {
            return Err(HEADER_TOO_LARGE);
        }
        if file_too_short(original_len, field_header_end) {
            return Err(HEADER_INVALID);
        }

        let mut field_header = [0u8; 5];
        read_exact_header(reader, &mut field_header)?;
        let field_id = field_header[0];
        let field_len = u32::from_le_bytes([
            field_header[1],
            field_header[2],
            field_header[3],
            field_header[4],
        ]);
        let data_len = usize::try_from(field_len).map_err(|_| HEADER_TOO_LARGE)?;

        if field_id == 0 && data_len != END_OF_HEADER.len() {
            return Err(HEADER_INVALID);
        }
        let data_end = field_header_end
            .checked_add(data_len)
            .ok_or(HEADER_TOO_LARGE)?;
        if data_end > HEADER_MAX_BYTES {
            return Err(HEADER_TOO_LARGE);
        }
        if file_too_short(original_len, data_end) {
            return Err(HEADER_INVALID);
        }
        if field_id != 0 {
            if seen[field_id as usize] {
                return Err(HEADER_INVALID);
            }
            seen[field_id as usize] = true;
        }

        header.extend_from_slice(&field_header);
        header.resize(data_end, 0);
        read_exact_header(reader, &mut header[field_header_end..data_end])?;

        if field_id == 0 {
            if header[field_header_end..data_end] != END_OF_HEADER
                && header[field_header_end..data_end] != VENDORED_END_OF_HEADER
            {
                return Err(HEADER_INVALID);
            }
            return Ok(header);
        }
    }
}

fn read_public_header_file(path: &str) -> Result<Vec<u8>, String> {
    if path.is_empty() || path.encode_utf16().count() > MAX_PATH_UNITS || path.contains('\0') {
        return Err(HEADER_INVALID.to_string());
    }

    let mut file = File::open(Path::new(path)).map_err(|_| HEADER_IO.to_string())?;
    let metadata = file.metadata().map_err(|_| HEADER_IO.to_string())?;
    if !metadata.is_file() {
        return Err(HEADER_INVALID.to_string());
    }

    parse_public_header(&mut file, Some(metadata.len())).map_err(str::to_owned)
}

#[tauri::command]
pub fn read_public_header(window: tauri::WebviewWindow, path: String) -> Result<Vec<u8>, String> {
    if window.label() != "main" {
        return Err(HEADER_FORBIDDEN.to_string());
    }
    read_public_header_file(&path)
}

#[cfg(test)]
mod tests {
    use super::{parse_public_header, read_public_header_file};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::path::Path;

    struct CountingReader<R> {
        inner: R,
        bytes_read: usize,
    }

    impl<R: Read> Read for CountingReader<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let count = self.inner.read(buf)?;
            self.bytes_read += count;
            Ok(count)
        }
    }

    fn version_header(major: u16, minor: u16) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x9AA2D903u32.to_le_bytes());
        bytes.extend_from_slice(&0xB54BFB67u32.to_le_bytes());
        let version = ((major as u32) << 16) | minor as u32;
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes
    }

    fn append_field(bytes: &mut Vec<u8>, id: u8, data: &[u8]) {
        bytes.push(id);
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(data);
    }

    fn append_end(bytes: &mut Vec<u8>) {
        append_field(bytes, 0, &[0x0d, 0x0a, 0x0d, 0x0a]);
    }

    fn valid_header() -> Vec<u8> {
        let mut bytes = version_header(4, 0);
        append_field(&mut bytes, 1, "猫".as_bytes());
        append_end(&mut bytes);
        bytes
    }

    fn write_synthetic(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn synthetic_file(bytes: &[u8]) -> (tempfile::TempDir, File) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-header.bin");
        write_synthetic(&path, bytes);
        let file = File::open(path).unwrap();
        (dir, file)
    }

    fn parse_synthetic(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (_dir, mut file) = synthetic_file(bytes);
        let length = file.metadata().unwrap().len();
        parse_public_header(&mut file, Some(length))
    }

    #[test]
    fn reads_only_public_header_not_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.kdbx");
        let expected = valid_header();
        write_synthetic(&path, &expected);
        let file = File::options().write(true).open(&path).unwrap();
        file.set_len(expected.len() as u64 + 32 * 1024 * 1024)
            .unwrap();
        drop(file);

        let file = File::open(&path).unwrap();
        let file_len = file.metadata().unwrap().len();
        let mut reader = CountingReader {
            inner: file,
            bytes_read: 0,
        };
        let header = parse_public_header(&mut reader, Some(file_len)).unwrap();

        assert_eq!(header, expected);
        assert_eq!(reader.bytes_read, expected.len());
    }

    #[test]
    fn accepts_current_vendored_engine_terminal_marker() {
        let mut bytes = version_header(4, 0);
        append_field(&mut bytes, 1, &[]);
        append_field(&mut bytes, 0, &[0, 208, 173, 10]);
        assert_eq!(parse_synthetic(&bytes).unwrap(), bytes);
    }

    #[test]
    fn rejects_empty_and_truncated_headers() {
        assert_eq!(parse_synthetic(&[]).unwrap_err(), "HEADER_INVALID");
        let truncated = version_header(4, 0);
        assert_eq!(parse_synthetic(&truncated).unwrap_err(), "HEADER_INVALID");
    }

    #[test]
    fn rejects_oversized_field_before_reading_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-header.bin");
        let mut bytes = version_header(4, 0);
        bytes.push(1);
        bytes.extend_from_slice(&(1_048_576 as u32).to_le_bytes());
        write_synthetic(&path, &bytes);
        let file = File::open(&path).unwrap();
        let mut reader = CountingReader {
            inner: file,
            bytes_read: 0,
        };

        assert_eq!(
            parse_public_header(&mut reader, None).unwrap_err(),
            "HEADER_TOO_LARGE"
        );
        assert_eq!(reader.bytes_read, 17);
    }

    #[test]
    fn rejects_field_length_overflow() {
        let mut bytes = version_header(4, 0);
        bytes.push(1);
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_synthetic(&bytes).unwrap_err(), "HEADER_TOO_LARGE");
    }

    #[test]
    fn rejects_invalid_end_marker() {
        let mut bytes = version_header(4, 0);
        append_field(&mut bytes, 1, &[]);
        append_field(&mut bytes, 0, &[0, 0, 0, 0]);
        assert_eq!(parse_synthetic(&bytes).unwrap_err(), "HEADER_INVALID");
    }

    #[test]
    fn rejects_wrong_signature() {
        let mut bytes = valid_header();
        bytes[0] ^= 0xff;
        assert_eq!(parse_synthetic(&bytes).unwrap_err(), "HEADER_INVALID");
    }

    #[test]
    fn reports_newer_kdbx4_minor_as_unsupported_not_corrupt() {
        assert_eq!(parse_synthetic(&version_header(4, 2)).unwrap_err(), "HEADER_UNSUPPORTED");
    }

    #[test]
    fn reports_kdbx3_as_unsupported() {
        assert_eq!(
            parse_synthetic(&version_header(3, 1)).unwrap_err(),
            "HEADER_UNSUPPORTED"
        );
    }

    #[test]
    fn rejects_duplicate_field_ids() {
        let mut bytes = version_header(4, 0);
        append_field(&mut bytes, 1, &[1]);
        append_field(&mut bytes, 1, &[2]);
        append_end(&mut bytes);
        assert_eq!(parse_synthetic(&bytes).unwrap_err(), "HEADER_INVALID");
    }

    #[test]
    fn preserves_unknown_field_bytes_and_multibyte_content() {
        let mut bytes = version_header(4, 1);
        append_field(&mut bytes, 200, "密钥🗝".as_bytes());
        append_end(&mut bytes);
        assert_eq!(parse_synthetic(&bytes).unwrap(), bytes);
    }

    #[test]
    fn rejects_empty_and_overlong_paths() {
        assert_eq!(read_public_header_file("").unwrap_err(), "HEADER_INVALID");
        let overlong = "x".repeat(32_768);
        assert_eq!(
            read_public_header_file(&overlong).unwrap_err(),
            "HEADER_INVALID"
        );
    }
}
