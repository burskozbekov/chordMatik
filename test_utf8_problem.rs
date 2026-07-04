fn main() {
    // The bug report claims that if the character BEFORE the " - " is multi-byte,
    // slicing could fail. Let's test this.
    
    // Test: Character immediately before " - " is a multi-byte UTF-8 sequence
    let s = "hello café - world";
    // "café" has é which is 2 bytes in UTF-8
    // h e l l o space c a f é space - space w o r l d
    // 0 1 2 3 4 5     6 7 8 9-10 11 12-13-14
    
    let i = s.find(" - ").unwrap();
    println!("String: {:?}", s);
    println!("Index of ' - ': {}", i);
    println!("String length: {}", s.len());
    
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| &s[..i]));
    match result {
        Ok(slice) => println!("Slice succeeded: {:?}", slice),
        Err(_) => println!("PANIC on slice!"),
    }
    
    println!("\n--- Testing with emoji before separator ---");
    let s2 = "Café🎵 - Artist";
    let i2 = s2.find(" - ").unwrap();
    println!("String: {:?}", s2);
    println!("Index of ' - ': {}", i2);
    println!("String length: {}", s2.len());
    
    let result2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| &s2[..i2]));
    match result2 {
        Ok(slice) => println!("Slice succeeded: {:?}", slice),
        Err(_) => println!("PANIC on slice!"),
    }
}
