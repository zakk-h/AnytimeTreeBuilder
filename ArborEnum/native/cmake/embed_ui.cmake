if(NOT EXISTS "${INPUT}")
  message(FATAL_ERROR "Builder HTML does not exist: ${INPUT}. Build the frontend first.")
endif()
file(READ "${INPUT}" ui_hex HEX)
# A byte array avoids MSVC's 64KB string-literal limit and preserves UTF-8
# exactly. Line breaks also keep generated source within compiler line limits.
string(REGEX REPLACE "(..)" "0x\\1," ui_bytes "${ui_hex}")
string(REPEAT "0x[0-9a-f][0-9a-f]," 24 line_pattern)
string(REGEX REPLACE "(${line_pattern})" "\\1\n" ui_bytes "${ui_bytes}")
file(WRITE "${OUTPUT}" "#pragma once\ninline constexpr unsigned char arborenum_embedded_ui[] = {\n${ui_bytes}\n};\n")
