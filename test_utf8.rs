fn main() {
    // Test 1: Normal ASCII
    let s1 = "hello - world";
    let i1 = s1.find(" - ").unwrap();
    println!("Test 1 (ASCII): index={}, slice={:?}", i1, &s1[..i1]);
    
    // Test 2: Emoji before " - "
    let s2 = "hello 🎵 - world";
    let i2 = s2.find(" - ").unwrap();
    println!("Test 2 (emoji before): index={}, string_len={}", i2, s2.len());
    // Emoji 🎵 is 4 bytes in UTF-8
    // string is: h e l l o space emoji(4 bytes) space - space w o r l d
    // Bytes:     0 1 2 3 4 5     6-9       10   11-12-13
    // So " - " starts at byte 10
    println!("Attempting slice at {}", i2);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| &s2[..i2]));
    match result {
        Ok(slice) => println!("  Success: {:?}", slice),
        Err(_) => println!("  PANIC!"),
    }
}
