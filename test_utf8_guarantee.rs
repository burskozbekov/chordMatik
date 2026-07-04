fn main() {
    // The Rust documentation guarantees that str::find() only returns
    // indices that are valid char boundaries.
    
    // Let's verify this with the actual UTF-8 spec
    let test_strings = vec![
        "hello - world",
        "café - artist",  // é is U+00E9 (2 bytes in UTF-8: C3 A9)
        "🎵 - artist",     // 🎵 is U+1F3B5 (4 bytes in UTF-8)
        "日本語 - artist",  // Japanese characters
    ];
    
    for s in test_strings {
        if let Some(i) = s.find(" - ") {
            println!("String: {:?}", s);
            println!("  Index: {}", i);
            
            // Check if index is valid by attempting slice
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                &s[..i]
            })) {
                Ok(slice) => println!("  Slice OK: {:?}", slice),
                Err(_) => println!("  PANIC on slice - BUG!"),
            }
            println!();
        }
    }
}
