# synthetic kunanyi-like DEM in MGA94 z55 (EPSG:28355), 4 m base, COG with overviews
import numpy as np, rasterio, sys
from rasterio.transform import from_origin
out = sys.argv[1]
cell = 4.0; x0, ytop = 508000.0, 5262000.0; n = 5000   # 20 km square
xs = x0 + (np.arange(n) + 0.5) * cell; ys = ytop - (np.arange(n) + 0.5) * cell
X, Y = np.meshgrid(xs, ys)
summit = (519400.0, 5251900.0)
d2 = ((X - summit[0])**2 + (Y - summit[1])**2)
z = 60 + 1210 * np.exp(-d2 / (2 * 2600.0**2))
z += 120 * np.sin(X / 700.0) * np.cos(Y / 900.0) * np.exp(-d2 / (2 * 5000.0**2))
z += 400 * np.exp(-((X - 512000)**2 + (Y - 5244000)**2) / (2 * 1500.0**2))
z = np.where(X > 526500, -9999.0, z).astype("float32")   # "sea" no-data on the east
prof = dict(driver="COG", width=n, height=n, count=1, dtype="float32", crs="EPSG:28355",
            transform=from_origin(x0, ytop, cell, cell), nodata=-9999.0, compress="DEFLATE",
            predictor=3, blocksize=512, overview_resampling="average")
with rasterio.open(out, "w", **prof) as dst:
    dst.write(z, 1)
with rasterio.open(out) as s:
    print(s.profile["blockxsize"], s.overviews(1))
