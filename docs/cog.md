# Is the DEM COG doing its job?

lunashade reads the Tasmania 2 m DEM straight from one cloud-optimised GeoTIFF (COG). How fast a load is
depends on how that file is laid out, so these notes cover what the page asks of the file, how to check the
file with GDAL from R (gdalraster), and how to re-cut it if it falls short.

## What the page asks for

Every load makes three kinds of request, one after the other. The status line reports each as
`requests, bytes, seconds`:

- **open**: the header and the image directory (IFD) of each level. A well-made COG keeps all of
  this at the front of the file, so it takes one or two requests.
- **square**: the area of interest plus a margin, at 2, 4, 8 or 16 m. It comes from full resolution or a
  near overview, a few dozen 512 x 512 tiles.
- **surround**: 80 km square at 64 m (the far field for shadows, skyline and viewshed). With a 2 m base
  that wants the 5th overview (4, 8, 16, 32, 64 m), about 9 tiles. If the pyramid stops sooner, the page
  reads the coarsest level there is and averages it down, at a cost of about 25 tiles from 32 m or about 100
  from 16 m. The status line shows which overview each read used
  (`COG overview n / m`, plus `averaged xk` when it had to average).

So for this use, a good file has:

1. A **full pyramid**, down to a level under about 512 pixels across.
2. **COG layout**: headers and IFDs at the front (`LAYOUT=COG`).
3. **Compression that suits float elevations**: DEFLATE or ZSTD with the floating-point predictor
   (`PREDICTOR=3`), or LERC with an error bound of about a centimetre. Without the predictor, float32
   elevations compress poorly and every tile is bigger than it needs to be.
4. **512 x 512 tiles** (256 also works: smaller over-reads, more requests).
5. **Nodata** declared, so the sea is not read as a height.

## Checking it with gdalraster

```r
library(gdalraster)
url <- "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif"
dsn <- paste0("/vsicurl/", url)
set_config_option("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")   # don't list the bucket

ds <- new(GDALRaster, dsn, TRUE)          # TRUE = read only (positional)
ds$info()                                 # size, block size, overviews, nodata, metadata
ds$dim(); ds$res()
ds$getBlockSize(1)                        # 512 512 is good
n <- ds$getOverviewCount(1); n            # want >= 5 for a 2 m base
ds$getMetadata(band = 0, domain = "IMAGE_STRUCTURE")   # COMPRESSION, LAYOUT=COG, ...
ds$getMetadata(band = 1, domain = "IMAGE_STRUCTURE")   # PREDICTOR is sometimes reported here

# resolution of each overview: open each level on its own
for (k in seq_len(n) - 1) {
  ov <- new(GDALRaster, dsn, TRUE, open_options = paste0("OVERVIEW_LEVEL=", k))
  cat("overview", k, ":", ov$dim()[1:2], "cells at", ov$res()[1], "m\n")
  ov$close()
}
```

### Counting the requests for a lunashade-sized read

GDAL can log every HTTP range request to a file. This repeats the page's surround read: 80 km around a
point, delivered at 64 m. GDAL picks the overview itself because the output is smaller than the window.

```r
logf <- tempfile(fileext = ".log")
set_config_option("CPL_LOG", logf)       # set before any other GDAL message is written
set_config_option("CPL_DEBUG", "ON")
vsi_curl_clear_cache()                   # start cold

ds <- new(GDALRaster, dsn, TRUE)
gt <- ds$getGeoTransform()               # x0, dx, 0, ytop, 0, -dy
read_mga <- function(ds, bbox, out_cell) {
  gt <- ds$getGeoTransform(); d <- ds$dim()
  xoff <- max(0, floor((bbox[1] - gt[1]) / gt[2]))
  yoff <- max(0, floor((gt[4] - bbox[4]) / -gt[6]))
  xend <- min(d[1], ceiling((bbox[3] - gt[1]) / gt[2]))
  yend <- min(d[2], ceiling((gt[4] - bbox[2]) / -gt[6]))
  xs <- xend - xoff; ys <- yend - yoff
  ds$read(1, xoff, yoff, xs, ys, round(xs * gt[2] / out_cell), round(ys * gt[2] / out_cell))
}
cen <- c(520300, 5247550)                # MGA zone 55, near Fern Tree
t0 <- Sys.time()
z <- read_mga(ds, c(cen - 40000, cen + 40000), 64)
Sys.time() - t0

log <- readLines(logf)
dl <- grep("VSICURL: Downloading", log, value = TRUE)
length(dl)                               # number of range requests
head(dl)                                 # byte ranges: one contiguous run is good, scattered is not
set_config_option("CPL_DEBUG", "OFF")
```

Repeat with the square (say 6 km around `cen`, `out_cell = 4`) to see the near read. GDAL and the page
(geotiff.js) don't make exactly the same requests: GDAL merges neighbouring ranges and keeps its own cache.
The counts should still be of the same order. The page's own numbers are in its status line.

## Re-cutting it

If the pyramid is short or the compression is unsuited to floats, re-cut it once; every reader benefits.
With the GDAL command line (for example on an HPC node; it takes a while for the whole state at 2 m):

```sh
gdal_translate Tasmania_Statewide_2m_DEM.tif tas-dem-2m-cog.tif -of COG \
  -co BLOCKSIZE=512 -co COMPRESS=ZSTD -co LEVEL=9 -co PREDICTOR=YES \
  -co OVERVIEWS=IGNORE_EXISTING -co OVERVIEW_RESAMPLING=AVERAGE \
  -co BIGTIFF=YES -co NUM_THREADS=ALL_CPUS
```

`PREDICTOR=YES` picks the floating-point predictor for float32 data. For smaller files at a known precision,
`-co COMPRESS=LERC_ZSTD -co MAX_Z_ERROR=0.01` keeps heights to within 1 cm. The same arguments go through
`gdalraster::translate(src, dst, cl_arg = c(...))` from R. Then point the page at the new file with
`?dem=<url>` and compare the status lines.
