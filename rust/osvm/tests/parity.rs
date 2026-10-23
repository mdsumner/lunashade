// Parity with js/osvm.js: tests/fixtures/parity.txt is written by
// `node test/make-parity.js` in lunashade and holds the JS answers for a few viewsheds.
use osvm::{sweep, viewshed, viewshed_mesh, Grid, Mesh, ShadeDomain, SweepOptions, ViewshedOptions};

struct Tok<'a>(std::str::SplitAsciiWhitespace<'a>);
impl Tok<'_> {
    fn f(&mut self) -> f64 {
        self.0.next().expect("token").parse().expect("number")
    }
    fn u(&mut self) -> usize {
        self.f() as usize
    }
}

struct OwnedGrid {
    z: Vec<f32>,
    w: usize,
    h: usize,
    cell: f64,
    x0: f64,
    ytop: f64,
}
impl OwnedGrid {
    fn view(&self) -> Grid<'_> {
        Grid {
            z: &self.z,
            w: self.w,
            h: self.h,
            cell: self.cell,
            x0: self.x0,
            ytop: self.ytop,
        }
    }
}

#[test]
fn matches_js() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/parity.txt")).unwrap();
    let mut t = Tok(text.split_ascii_whitespace());
    let ng = t.u();
    let grids: Vec<OwnedGrid> = (0..ng)
        .map(|_| {
            let (w, h, cell, x0, ytop) = (t.u(), t.u(), t.f(), t.f(), t.f());
            let z = (0..w * h).map(|_| t.f() as f32).collect();
            OwnedGrid { z, w, h, cell, x0, ytop }
        })
        .collect();
    let views: Vec<Grid> = grids.iter().map(|g| g.view()).collect();
    let nc = t.u();
    for ci in 0..nc {
        let (kind, rings, eye, curv, max_dist, e, n) = (t.u(), t.u(), t.f(), t.f(), t.f(), t.f(), t.f());
        let opts = ViewshedOptions {
            eye,
            curvature: curv > 0.0,
            max_dist: if max_dist < 0.0 { f64::INFINITY } else { max_dist },
            ..Default::default()
        };
        let (res, cycles) = if kind == 0 {
            (viewshed(&views[..rings], e, n, &opts).unwrap(), -1i64)
        } else {
            let g = &grids[0];
            let flip: Vec<u8> = (0..(g.w - 1) * (g.h - 1)).map(|_| t.u() as u8).collect();
            let (x, y, z, tri) = grid_mesh(g, &flip);
            let mesh = Mesh {
                x: &x,
                y: &y,
                z: &z,
                tri: &tri,
            };
            let (r, c) = viewshed_mesh(&mesh, e, n, None, &opts).unwrap();
            (r, c as i64)
        };
        let (area, n_tri, n_vis, n_hid, n_pieces, n_env, cyc) = (t.f(), t.u(), t.u(), t.u(), t.u(), t.u(), t.f() as i64);
        let sky: Vec<f64> = (0..360).map(|_| t.f()).collect();
        let rel = (res.area - area).abs() / area;
        let dsky = res
            .skyline
            .iter()
            .zip(&sky)
            .map(|(a, b)| (a - *b as f32 as f64).abs())
            .fold(0.0, f64::max);
        println!(
            "case {ci}: area {:.3} vs js {:.3} (rel {:.1e}); tri {} / {}; visible tri {} / {}; quick {} / {}; pieces {} / {}; envelope {} / {}; cycles {} / {}; skyline max diff {:.2e} deg",
            res.area, area, rel, res.n_tri, n_tri, res.n_vis_tri, n_vis, res.n_quick_hidden, n_hid, res.pieces.len(), n_pieces, res.envelope_points, n_env, cycles, cyc, dsky
        );
        assert_eq!(res.n_tri, n_tri, "case {ci}: triangle count");
        assert!(rel < 1e-9, "case {ci}: area differs by {rel:e}");
        let close = |a: usize, b: usize| (a as f64 - b as f64).abs() <= 1.0 + 1e-4 * b as f64;
        assert!(
            close(res.n_vis_tri, n_vis) && close(res.pieces.len(), n_pieces),
            "case {ci}: counts"
        );
        assert_eq!(cycles, cyc, "case {ci}: cycles");
        assert!(dsky < 1e-4, "case {ci}: skyline");
    }
    // shade masks, cell for cell
    let ns = t.u();
    for si in 0..ns {
        let (az, elev, two) = (t.f(), t.f(), t.u());
        let want: Vec<u8> = t.0.next().unwrap().bytes().map(|b| b - b'0').collect();
        let got = if two == 1 {
            ShadeDomain::new(views[0], Some(views[1])).shade_at(az, elev, 0.2)
        } else {
            let g = &views[0];
            sweep(g.z, g.w, g.h, g.cell, az, elev, &SweepOptions::default()).0
        };
        let diff = got.iter().zip(&want).filter(|(a, b)| a != b).count();
        println!(
            "shade {si}: az {az} elev {elev} two-level {two}: {diff} of {} cells differ",
            want.len()
        );
        assert_eq!(diff, 0, "shade case {si}");
    }
}

fn grid_mesh(g: &OwnedGrid, flip: &[u8]) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<u32>) {
    let (mut x, mut y, mut z, mut tri) = (vec![], vec![], vec![], vec![]);
    for r in 0..g.h {
        for c in 0..g.w {
            x.push(g.x0 + (c as f64 + 0.5) * g.cell);
            y.push(g.ytop - (r as f64 + 0.5) * g.cell);
            z.push(g.z[r * g.w + c] as f64);
        }
    }
    for r in 0..g.h - 1 {
        for c in 0..g.w - 1 {
            let tl = (r * g.w + c) as u32;
            let (tr, bl) = (tl + 1, tl + g.w as u32);
            let br = bl + 1;
            if flip[r * (g.w - 1) + c] != 0 {
                tri.extend_from_slice(&[tl, tr, bl, tr, br, bl]);
            } else {
                tri.extend_from_slice(&[tl, tr, br, tl, br, bl]);
            }
        }
    }
    (x, y, z, tri)
}
