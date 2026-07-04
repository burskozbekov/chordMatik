// The Rust str::find() implementation is guaranteed to:
// 1. Only match complete patterns
// 2. Only return byte indices that are valid UTF-8 char boundaries
// 
// This is mathematically guaranteed because:
// - The pattern " - " starts with space (0x20), an ASCII byte
// - ASCII bytes (0x00-0x7F) are always valid char boundaries
// - Multi-byte UTF-8 sequences start with bytes 0xC0-0xFF
// - Continuation bytes are 0x80-0xBF
// - So if find() finds the pattern starting at some index i,
//   that byte at position i is guaranteed to be the start of a char

fn main() {
    // Test that we can construct a problematic case
    // where find() should still work correctly
    
    // Scenario: title ends with multi-byte char, then has " - "
    let title = "Song With Café - Artist Name";
    
    println!("Title: {}", title);
    println!("Bytes: {:?}", title.as_bytes());
    
    match title.find(" - ") {
        Some(i) => {
            println!("Found ' - ' at index: {}", i);
            
            // Check this is a valid char boundary
            if is_char_boundary(title, i) {
                println!("Index {} is a valid char boundary", i);
            }
            
            // Slice is safe
            println!("Artist part: {}", &title[..i]);
        }
        None => println!("Not found"),
    }
}

fn is_char_boundary(s: &str, index: usize) -> bool {
    if index > s.len() {
        return false;
    }
    if index == 0 || index == s.len() {
        return true;
    }
    let b = s.as_bytes()[index];
    // A valid continuation byte never starts a character.
    // The bit pattern of a continuation byte is 10xxxxxx.
    (b & 0xc0) != 0x80
}
