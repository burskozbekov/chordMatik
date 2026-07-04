// This demonstrates the Rust guarantee:
// str::find() returns an index that is always a valid char boundary

fn test_find_guarantee() {
    // From Rust docs: 
    // "If the needle is not found, None is returned."
    // "Returns the byte index of the first character of this string slice 
    // that matches the pattern, if it matches."
    // The key word: "byte index" and the pattern search only returns valid boundaries
    
    let s = "Héllo - Wörld";  // Mixed ASCII and multibyte chars
    
    // 'H' (1 byte) 'é' (2 bytes) 'l' 'l' 'o' ' ' '-' ' ' 'W' 'ö' (2 bytes) 'r' 'l' 'd'
    // Indices: 0-0, 1-2, 3, 4, 5, 6, 7, 8, 9, 10-11, 12, 13, 14
    
    if let Some(idx) = s.find(" - ") {
        // idx is guaranteed to be a valid char boundary
        println!("Found at byte index: {}", idx);
        
        // This is SAFE because find() guarantees char boundary
        let before = &s[..idx];
        let after = &s[idx + 3..];  // 3 = len(" - ")
        
        println!("Before: {}", before);
        println!("After: {}", after);
    }
}

fn main() {
    test_find_guarantee();
}
