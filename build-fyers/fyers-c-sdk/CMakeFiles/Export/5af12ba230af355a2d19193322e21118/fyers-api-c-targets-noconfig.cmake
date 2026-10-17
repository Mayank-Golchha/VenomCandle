#----------------------------------------------------------------
# Generated CMake target import file.
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "fyers-api-c::fyers-api-c" for configuration ""
set_property(TARGET fyers-api-c::fyers-api-c APPEND PROPERTY IMPORTED_CONFIGURATIONS NOCONFIG)
set_target_properties(fyers-api-c::fyers-api-c PROPERTIES
  IMPORTED_IMPLIB_NOCONFIG "${_IMPORT_PREFIX}/lib/libfyers-api-c.dll.a"
  IMPORTED_LOCATION_NOCONFIG "${_IMPORT_PREFIX}/bin/libfyers-api-c.dll"
  )

list(APPEND _cmake_import_check_targets fyers-api-c::fyers-api-c )
list(APPEND _cmake_import_check_files_for_fyers-api-c::fyers-api-c "${_IMPORT_PREFIX}/lib/libfyers-api-c.dll.a" "${_IMPORT_PREFIX}/bin/libfyers-api-c.dll" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
