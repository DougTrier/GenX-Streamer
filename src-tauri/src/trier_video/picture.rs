//! Picture level: starting frames and field pairs, completing them, keeping
//! the two reference frames, and handing frames out in display order.
use super::*;

impl Decoder {
    /// After the picture coding extension: start a frame, or the second field
    /// of the frame already started.
    pub(super) fn begin_picture(&mut self) {
        let Some((width, height)) = self
            .seq
            .as_ref()
            .map(|s| (s.mb_width * 16, s.mb_height * 16))
        else {
            return;
        };
        let pic = self.pic;
        let pts = self.pending_pts.take().unwrap_or(0);
        if pic.structure == 0 {
            return;
        }
        let second_field = pic.structure != FRAME
            && self
                .current
                .as_ref()
                .is_some_and(|c| c.first_field.is_some_and(|f| f != pic.structure));
        if second_field {
            let cur = self.current.as_mut().expect("checked");
            // The second field of a P frame may predict from the first.
            if pic.coding_type == P_PIC {
                cur.first_field_copy = Some(Arc::new(Planes {
                    y: cur.planes.y.clone(),
                    cb: cur.planes.cb.clone(),
                    cr: cur.planes.cr.clone(),
                    width: cur.planes.width,
                    height: cur.planes.height,
                }));
            }
            cur.picture.coding_type = cur.picture.coding_type.min(pic.coding_type);
            self.have_picture_header = true;
            return;
        }
        // A new frame: anything unfinished before it is dropped.
        self.current = None;
        let decodable = match pic.coding_type {
            I_PIC => true,
            P_PIC => self.newer.is_some() && !self.need_intra,
            _ => self.older.is_some() && self.newer.is_some() && !self.need_intra,
        };
        if !decodable {
            return;
        }
        let (planes, dirty) = self.take_planes(width, height);
        self.current = Some(Current {
            planes,
            cleared: if dirty { vec![false; 1] } else { Vec::new() },
            reference: pic.coding_type != B_PIC,
            pts,
            picture: pic,
            first_field: None,
            first_field_copy: None,
            rows_seen: Vec::new(),
        });
        self.have_picture_header = true;
    }

    /// At the end of a picture's data: a frame picture or a second field
    /// completes its frame; a first field waits for its partner.
    pub(super) fn finish_picture(&mut self) {
        if !self.have_picture_header {
            return;
        }
        self.have_picture_header = false;
        self.stats.pictures += 1;
        self.stats.last_type = self.pic.coding_type;
        self.stats.last_structure = self.pic.structure;
        self.conceal_missing_rows();
        let structure = self.pic.structure;
        let Some(cur) = self.current.as_mut() else {
            return;
        };
        if structure != FRAME && cur.first_field.is_none() {
            cur.first_field = Some(structure);
            return;
        }
        let cur = self.current.take().expect("checked");
        let Some(seq) = self.seq.as_ref() else { return };
        let planes = Arc::new(cur.planes);
        self.planes.push(planes.clone());
        let frame = Frame {
            planes,
            width: seq.width,
            height: seq.height,
            pts: cur.pts,
            progressive: cur.picture.progressive_frame,
            top_field_first: cur.picture.top_field_first,
            repeat_first_field: cur.picture.repeat_first_field,
        };
        if cur.reference {
            self.older = self.newer.take();
            self.newer = Some(frame.planes.clone());
            if cur.picture.coding_type == I_PIC {
                self.need_intra = false;
            }
            if let Some(previous) = self.newer_frame.replace(frame) {
                self.out.push(previous);
            }
        } else {
            self.out.push(frame);
        }
    }

    /// sequence_end_code: the last reference frame is due now.
    pub(super) fn finish_frame_if_complete(&mut self, end_of_sequence: bool) {
        self.finish_picture();
        if end_of_sequence {
            if let Some(frame) = self.newer_frame.take() {
                self.out.push(frame);
            }
        }
    }
}
