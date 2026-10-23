// cargo run --release --example bench : the app-sized case from test/test-osvm.js
// (1000 x 1000 at 4 m near, 1250 x 1250 at 64 m far), same synthetic terrain.
use osvm::{viewshed, Grid, ViewshedOptions};
use std::time::Instant;

fn terrain(w: usize, h: usize, s0: f64) -> Vec<f32> {
    let hills = [
        [0.3, 0.35, 900.0, 0.10],
        [0.7, 0.6, 600.0, 0.06],
        [0.5, 0.8, 300.0, 0.03],
        [0.15, 0.8, 400.0, 0.02],
    ];
    let mut z = vec![0f32; w * h];
    for r in 0..h {
        for c in 0..w {
            let (u, v) = (c as f64 / w as f64, r as f64 / h as f64);
            let mut s = 50.0 + 30.0 * (u * 40.0 + s0).sin() * (v * 33.0).cos() + 8.0 * (u * 170.0).sin() * (v * 150.0 + s0).sin();
            for k in &hills {
                let d2 = (u - k[0]) * (u - k[0]) + (v - k[1]) * (v - k[1]);
                s += k[2] * (-d2 / (2.0 * k[3] * k[3])).exp();
            }
            z[r * w + c] = s as f32;
        }
    }
    z
}

fn main() {
    let (zn, zf) = (terrain(1000, 1000, 3.0), terrain(1250, 1250, 3.0));
    let near = Grid {
        z: &zn,
        w: 1000,
        h: 1000,
        cell: 4.0,
        x0: 0.0,
        ytop: 4000.0,
    };
    let far = Grid {
        z: &zf,
        w: 1250,
        h: 1250,
        cell: 64.0,
        x0: -38000.0,
        ytop: 42000.0,
    };
    for (label, md) in [("40 km", f64::INFINITY), ("20 km", 20000.0)] {
        let t0 = Instant::now();
        let r = viewshed(
            &[near, far],
            2000.0,
            2000.0,
            &ViewshedOptions {
                max_dist: md,
                ..Default::default()
            },
        )
        .unwrap();
        println!(
            "{label}: {} triangles, {} pieces, {} rejected early, {:.2} km2 visible, {} ms",
            r.n_tri,
            r.pieces.len(),
            r.n_quick_hidden,
            r.area / 1e6,
            t0.elapsed().as_millis()
        );
    }
}
