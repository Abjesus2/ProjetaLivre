// Versão de arquivo único (ProjetaLivre.html): o leitor reserva de DWG (LibreDWG, 9,5 MB) fica de
// fora para o arquivo continuar leve. O DWG é lido pelo CADCraft; este módulo só responde se o
// CADCraft falhar.
export const Dwg_File_Type = { DWG: 0 };
export const LibreDwg = {
  async create(): Promise<never> {
    throw new Error('O leitor CADCraft não conseguiu ler este DWG. Tente a versão on-line do ProjetaLivre (que tem um leitor alternativo) ou salve o arquivo como DXF.');
  },
};
