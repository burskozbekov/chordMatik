// A potential misunderstanding: confusion between byte index vs char index
// and confusion about what find() returns

// Case that COULD panic if misused:
fn unsafe_example() {
    let s = "café";  // é is 2 bytes
    // If someone MANUALLY constructed index 4 (thinking it's after é)
    // and tried to slice: s[..4], it WOULD work (it's the end of the string)
    // But if they constructed index 3, which is in the MIDDLE of é:
    // s[..3] would PANIC
    
    // However, str::find() NEVER returns such an invalid index
    
    println!("String: {}", s);
    println!("Bytes: {:?}", s.as_bytes());
    
    // Correct usage with find:
    if let Some(i) = s.find("é") {
        println!("Found 'é' at index: {}", i);  // Returns 3 (correct char boundary)
        println!("Slice [..i] = {}", &s[..i]);  // Works correctly
        println!("Slice [i..] = {}", &s[i..]);  // Works correctly
    }
}

fn main() {
    unsafe_example();
}
