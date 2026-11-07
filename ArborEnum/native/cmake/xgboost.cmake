# CPU-only XGBoost, statically linked on every desktop platform. Both archives
# are pinned to release 3.1.3's exact source and submodule commits.
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()
include(FetchContent)
FetchContent_Declare(xgboost
  URL https://codeload.github.com/dmlc/xgboost/tar.gz/2ac59440c9e2c42ede340bee553de07db1e0956d
  URL_HASH SHA256=a1b152573ba45cfc42fc1b32e4969ee725e1d43e6139e51ac0e5a611e6be8eef
  SOURCE_SUBDIR atb-download-only)
FetchContent_MakeAvailable(xgboost)
FetchContent_Declare(atb_dmlc
  URL https://codeload.github.com/dmlc/dmlc-core/tar.gz/8986b0598df709117570984571476c3614f55724
  URL_HASH SHA256=165ea73682f4a11fdea686c2ebd213eed42af69d0128896cc58da5661b0dfe3a
  SOURCE_DIR "${xgboost_SOURCE_DIR}/dmlc-core"
  SOURCE_SUBDIR atb-download-only)
FetchContent_MakeAvailable(atb_dmlc)
set(BUILD_STATIC_LIB ON CACHE BOOL "" FORCE)
set(USE_OPENMP OFF CACHE BOOL "" FORCE)
set(USE_CUDA OFF CACHE BOOL "" FORCE)
set(USE_DISTRIBUTED OFF CACHE BOOL "" FORCE)
set(USE_HDFS OFF CACHE BOOL "" FORCE)
set(USE_AZURE OFF CACHE BOOL "" FORCE)
set(USE_S3 OFF CACHE BOOL "" FORCE)
set(GOOGLE_TEST OFF CACHE BOOL "" FORCE)
set(KEEP_BUILD_ARTIFACTS_IN_BINARY_DIR ON CACHE BOOL "" FORCE)
add_subdirectory("${xgboost_SOURCE_DIR}" "${xgboost_BINARY_DIR}" EXCLUDE_FROM_ALL)
install(FILES "${xgboost_SOURCE_DIR}/LICENSE" DESTINATION licenses RENAME XGBoost.LICENSE COMPONENT Runtime)
install(FILES "${xgboost_SOURCE_DIR}/dmlc-core/LICENSE" DESTINATION licenses RENAME dmlc-core.LICENSE COMPONENT Runtime)
