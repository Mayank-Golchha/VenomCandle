
####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was fyers-api-c-config.cmake.in                            ########

get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../" ABSOLUTE)

macro(set_and_check _var _file)
  set(${_var} "${_file}")
  if(NOT EXISTS "${_file}")
    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
  endif()
endmacro()

macro(check_required_components _NAME)
  foreach(comp ${${_NAME}_FIND_COMPONENTS})
    if(NOT ${_NAME}_${comp}_FOUND)
      if(${_NAME}_FIND_REQUIRED_${comp})
        set(${_NAME}_FOUND FALSE)
      endif()
    endif()
  endforeach()
endmacro()

####################################################################################

include(CMakeFindDependencyMacro)
find_dependency(CURL)
find_dependency(OpenSSL)
find_dependency(Threads)

# cJSON: find_package on Windows (vcpkg), pkg-config on Unix
if(WIN32)
    find_dependency(cjson CONFIG)
else()
    find_package(PkgConfig REQUIRED)
    pkg_search_module(CJSON REQUIRED IMPORTED_TARGET cjson libcjson)
endif()

include("${CMAKE_CURRENT_LIST_DIR}/fyers-api-c-targets.cmake")
